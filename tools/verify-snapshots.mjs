#!/usr/bin/env node
/**
 * Read-only evidence audit for WhaTap Harness v0.2.0.
 * Consumes actual previously captured HTTP API + MCP response JSON from runs/.
 * No network calls, child processes, changes to source, or writes to evidence.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { assessReference, classifyMcpResult, compareRows, extractContent } from '../dist/validator.js';

const root = process.cwd();
const config = JSON.parse(await readFile(join(root, 'config/harness.json'), 'utf8'));
const scenarioById = new Map(config.scenarios.map(s => [s.id, s]));
const expectedEndpoints = {
  'server-metrics': { path: '/open/api/flush/mxql/path', mql: '/v2/sys/server_base' },
  'apm-transaction-stats': { path: '/open/api/v2/stat/transaction' },
  'apm-exception-stats': { path: '/open/api/v2/stat/error' },
  'apm-tps-series': { path: '/open/api/flush/mxql/path', mql: '/v2/app/tps_pcode' },
  'apm-error-series': { path: '/open/api/flush/mxql/path', mql: '/v2/app/tx_error_pcode' },
};
const optionalDir = process.argv[2];
async function latestRun() {
  const dir = resolve(root, config.outputDir);
  const children = await readdir(dir, { withFileTypes: true });
  const entries = await Promise.all(children.filter(v => v.isDirectory()).map(async v => {
    const directory = join(dir, v.name);
    const report = join(directory, 'report.json');
    try { return { directory, t: (await stat(report)).mtimeMs }; }
    catch { return null; }
  }));
  const existing = entries.filter(Boolean).sort((a,b) => b.t-a.t);
  if (!existing.length) throw new Error('runs/ 에 report.json 이 없습니다. npm run run 을 먼저 실행하세요.');
  return existing[0].directory;
}
const runDir = optionalDir ? (isAbsolute(optionalDir) ? optionalDir : resolve(root, optionalDir)) : await latestRun();
const report = JSON.parse(await readFile(join(runDir, 'report.json'), 'utf8'));
if (report.mode !== 'observe-only' || report.sourceModified !== false) {
  throw new Error('observe-only 보고서가 아닙니다. 중단합니다.');
}
const byId = new Map(report.scenarios.map(s => [s.id, s]));
const checkResults = [];
const pass = (label, detail) => { console.log(`  [통과] ${label}${detail ? ': '+detail : ''}`); checkResults.push({ label, status: 'PASS', detail }); };
const fail = (label, detail) => { console.log(`  [문제] ${label}: ${detail}`); checkResults.push({ label, status: 'ISSUE', detail }); };
const note = (label, detail) => { console.log(`  [정보] ${label}: ${detail}`); };
const short = err => (err instanceof Error ? err.message : String(err)).replace(/\s+/g,' ').slice(0,300);

async function readEvidence(meta, label) {
  if (!meta?.file || !meta?.sha256) throw new Error(`${label}: 근거 파일 또는 SHA-256 기록이 없습니다.`);
  const path = resolve(runDir, meta.file);
  if (!path.startsWith(resolve(runDir) + '/')) throw new Error(`${label}: 실행 폴더 외부 경로는 읽지 않습니다.`);
  const bytes = await readFile(path);
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash, meta.sha256, `${label}: 증거 파일 SHA-256 불일치`);
  return JSON.parse(bytes.toString('utf8'));
}

const referenceCache = new Map();
async function reference(id) {
  if (referenceCache.has(id)) return referenceCache.get(id);
  const s = scenarioById.get(id), r = byId.get(id);
  if (!s || !r) throw new Error(`${id} 시나리오/보고서가 없습니다.`);
  assert.deepEqual(r.timeWindow, {stime:s.stime,etime:s.etime}, `${id}: 시나리오 시간 범위 변경`);
  assert.equal(r.projectCode,s.projectCode,`${id}: 시나리오 프로젝트 변경`);
  assert.equal(r.referenceTool,s.referenceTool,`${id}: 참조 도구 변경`);
  const saved = await readEvidence(r.reference, id+'-reference');
  const payload = extractContent(saved);
  const expectation = expectedEndpoints[id];
  if (!expectation) throw new Error(`${id}: 사전에 승인된 HTTP 경로가 아닙니다.`);
  const actual = payload?.request;
  assert.equal(actual?.path,expectation.path,`${id}: HTTP 요청 경로가 다릅니다.`);
  assert.equal(actual?.method,'POST',`${id}: HTTP 메서드가 POST 가 아닙니다.`);
  assert.equal(actual?.projectCode,s.projectCode,`${id}: HTTP 요청 프로젝트 코드가 다릅니다.`);
  assert.equal(actual?.payload?.stime,s.stime,`${id}: HTTP 요청 시작 시각이 다릅니다.`);
  assert.equal(actual?.payload?.etime,s.etime,`${id}: HTTP 요청 종료 시각이 다릅니다.`);
  if (expectation.mql) assert.equal(actual?.payload?.mql,expectation.mql,`${id}: HTTP 요청 MXQL 이 다릅니다.`);
  if ('limit' in actual.payload) throw new Error(`${id}: HTTP 조회에 명시적 limit 이 전달됐습니다.`);
  const assessment = assessReference(s,payload);
  if (!assessment.complete || !assessment.rows) {
    throw new Error(`${id}: 기준 응답이 불완전합니다: ${assessment.checks.filter(c=>!c.ok).map(c=>c.code).join(',')}`);
  }
  referenceCache.set(id, {s,r,rows:assessment.rows});
  return referenceCache.get(id);
}

console.log('WhaTap Harness — 실제 저장 응답 검증 (읽기 전용)');
console.log('대상:',runDir);
console.log('API/MCP 재호출: 없음 | 원본 파일 변경: 없음\n');

try {
  // 1: Real HTTP rows + cloned candidate MUST match.
  console.log('[1/5] 실제 HTTP 서버 데이터 → 동일한 Candidate 복제본');
  const server = await reference('server-metrics');
  const clone = structuredClone(server.rows);
  const equal = compareRows(server.s,server.rows,clone);
  if (equal.status === 'PASS') pass('동일 데이터 비교', `${server.rows.length}행, ${equal.reason}`);
  else fail('동일 데이터 비교', `${equal.status} (${equal.reason})`);

  // 2: Mutation in candidate only MUST fail.
  console.log('\n[2/5] 실제 서버 CPU 한 행의 값 변경');
  const altered = structuredClone(server.rows);
  if (!altered.length || typeof altered[0].cpu !== 'number') throw new Error('서버 CPU 첫 행이 숫자가 아닙니다.');
  altered[0].cpu += 10;
  const unequal = compareRows(server.s,server.rows,altered);
  if (unequal.status === 'FAIL' && unequal.reason === 'FIELD_MISMATCH') pass('CPU 값 차이 탐지',unequal.reason);
  else fail('CPU 값 차이 탐지',`${unequal.status} (${unequal.reason})`);

  // 3: Delete one actual 5-second timestamp candidate row.
  console.log('\n[3/5] 실제 TPS 시계열 한 구간 제거');
  const tps = await reference('apm-tps-series');
  const middle = Math.floor(tps.rows.length/2);
  const removedTime = tps.rows[middle]?.time;
  const gap = tps.rows.filter(r=>r.time!==removedTime);
  const missing = compareRows(tps.s,tps.rows,gap);
  // Reuse the 5-second completeness checker for the intentionally shortened series.
  const gapCoverage = assessReference(tps.s,{ok:true,status:200,body:gap});
  if (missing.status === 'FAIL' && !gapCoverage.complete &&
      gapCoverage.checks.some(c=>c.code==='TIMESERIES_COVERAGE' && !c.ok)) {
    pass('시계열 구간 누락 탐지',`제거한 시각 ${removedTime}, ${missing.reason}, TIMESERIES_COVERAGE 실패`);
  } else fail('시계열 구간 누락 탐지',`${missing.status}/${missing.reason}; coverage=${gapCoverage.complete}`);

  // 4: Compare transport values, not reference metric types.
  console.log('\n[4/5] 값의 동일성 검증 (자료형 무관) 및 필드 누락');
  const absent = structuredClone(server.rows);
  delete absent[0].cpu;
  const missingField = compareRows(server.s,server.rows,absent);
  if (missingField.status === 'FAIL') pass('한쪽에만 필드 누락 탐지',missingField.reason);
  else fail('한쪽에만 필드 누락 탐지',`${missingField.status}/${missingField.reason}`);

  const numericText = structuredClone(server.rows);
  numericText[0].cpu = String(numericText[0].cpu);
  const sameNumericValue = compareRows(server.s,server.rows,numericText);
  if (sameNumericValue.status === 'PASS') pass('숫자와 동일한 숫자 문자열은 일치',sameNumericValue.reason);
  else fail('숫자와 동일한 숫자 문자열은 일치',`${sameNumericValue.status}/${sameNumericValue.reason}`);

  const alteredText = structuredClone(server.rows);
  alteredText[0].cpu = 'abc';
  const wrongValue = compareRows(server.s,server.rows,alteredText);
  if (wrongValue.status === 'FAIL') pass('서로 다른 값 탐지 (숫자 ↔ abc)',wrongValue.reason);
  else fail('서로 다른 값 탐지 (숫자 ↔ abc)',`${wrongValue.status}/${wrongValue.reason}`);

  const malformedReference = structuredClone(server.rows);
  const malformedCandidate = structuredClone(server.rows);
  malformedReference[0].cpu = 'abc';
  malformedCandidate[0].cpu = 'abc';
  const symmetrical = compareRows(server.s,malformedReference,malformedCandidate);
  if (symmetrical.status === 'PASS') pass('양쪽 값이 같은 abc 는 일치로 판정 (API 유효성은 별개)',symmetrical.reason);
  else fail('양쪽 값이 같은 abc 는 일치로 판정',`${symmetrical.status}/${symmetrical.reason}`);

  const bothAbsentRef = structuredClone(server.rows);
  const bothAbsentCandidate = structuredClone(server.rows);
  delete bothAbsentRef[0].cpu; delete bothAbsentCandidate[0].cpu;
  const unavailable = compareRows(server.s,bothAbsentRef,bothAbsentCandidate);
  if (unavailable.status === 'UNVERIFIABLE') pass('양쪽 모두 비교 필드가 없으면 검증 불가',unavailable.reason);
  else fail('양쪽 모두 비교 필드가 없으면 검증 불가',`${unavailable.status}/${unavailable.reason}`);

  // 5: Use REAL captured candidate output, not a mock or cloned reference.
  console.log('\n[5/5] 실제 저장된 WhaTap MCP 응답 ↔ HTTP 원본');
  for (const id of config.scenarios.map(s=>s.id)) {
    const {s,r,rows} = await reference(id);
    if (!s.mcpPath) {
      note(id,'대응 MCP 도구 미설정(UNMAPPED); 실제 결과값 비교 불가');
      continue;
    }
    if (!r.candidate.file) {
      fail(id,`MCP 근거 파일 없음: ${r.reason}`);
      continue;
    }
    const rawCandidate = await readEvidence(r.candidate, id+'-candidate');
    const actual = classifyMcpResult(rawCandidate);
    const args = r.candidate.args ?? {};
    const timeRange = `${new Date(s.stime).toISOString()} to ${new Date(s.etime).toISOString()}`;
    const sameWindow = args.stime===s.stime && args.etime===s.etime || args.timeRange===timeRange;
    const samePath = args.path===s.mcpPath && args.projectCode===s.projectCode;
    if (!sameWindow || !samePath) {
      fail(id,'MCP 호출 조건이 사전 정의된 경로·프로젝트·절대 시간과 다름');
      continue;
    }
    if (actual.kind==='error') {
      note(id,`UNVERIFIABLE — 실제 MCP 오류: ${short(actual.error)}`);
      continue;
    }
    if (actual.kind==='formatted') {
      note(id,'UNVERIFIABLE — MCP 데이터가 원본 JSON 행이 아닌 텍스트/표 형식');
      continue;
    }
    const comparison=compareRows(s,rows,actual.rows);
    if (comparison.status==='PASS') {
      pass(id,`실제 MCP와 HTTP ${rows.length}행 일치`);
    } else if (comparison.status==='FAIL') {
      note(id,`FAIL — MCP 원본과 HTTP 불일치: ${comparison.reason}`);
    } else {
      note(id,`UNVERIFIABLE — ${comparison.reason}`);
    }
  }
} catch (error) {
  fail('감사 실행 중단',short(error));
}
console.log('\n검증기 테스트 요약:');
const count=(status)=>checkResults.filter(r=>r.status===status).length;
console.log(`  통과 ${count('PASS')}건 / 발견된 문제 ${count('ISSUE')}건`);
console.log('주의: 1~4번은 실측 HTTP 데이터를 바탕으로 Candidate 를 메모리에서 변형한 테스트이며 실제 MCP 동작을 뜻하지 않습니다.');
console.log('      5번만 이전 Harness 실행에서 수집한 실제 MCP 응답입니다.');
if (count('ISSUE')>0) process.exitCode=1;
