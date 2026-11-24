import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { checkSummary, compareSubset, isBoundaryOnlyShift } from './agent.js';
import { StdioMcpClient } from './mcp.js';
import { expectedDurationMs, parseFormattedMcp } from './period.js';
import { localCommand } from './phased.js';
import { relativeReplayArgs } from './replay.js';
import { alignedStatsWindow, analyzeStats } from './statistics.js';
import type { HarnessConfig, McpToolResult, RunReport, ScenarioReport } from './types.js';
import { assessReference, extractContent, isWithinTimeWindow, verifyReferenceRequest } from './validator.js';

const runner = `
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
const [dist, input] = process.argv.slice(2);
const { config, options, tools, candidate, reference } = JSON.parse(await readFile(input));
const { StdioMcpClient } = await import(pathToFileURL(join(dist, 'mcp.js')));
const { runAgentHarness } = await import(pathToFileURL(join(dist, 'agent.js')));
const trace = { candidate: 0, reference: 0, unexpected: 0 };
StdioMcpClient.prototype.start = async () => {};
StdioMcpClient.prototype.close = async () => {};
StdioMcpClient.prototype.listTools = async () => tools;
StdioMcpClient.prototype.callTool = async function (tool, args) {
  const isCandidate = this.entry === config.servers.candidate;
  const entry = isCandidate ? candidate : reference[trace.reference];
  trace[isCandidate ? 'candidate' : 'reference']++;
  if (!entry || entry.tool !== tool || !isDeepStrictEqual(entry.args, args)) {
    trace.unexpected++;
    throw Error('Unexpected replay tool or arguments');
  }
  return structuredClone(entry.result);
};
const { runDir } = await runAgentHarness(config, options);
await writeFile(join(config.outputDir, 'result.json'), JSON.stringify({ runDir, trace }), { flag: 'wx' });
`;

const hashed = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex');
type Call = { tool: string; args: Record<string, unknown>; result: McpToolResult };

export async function reproduceHarnessFailure(config: HarnessConfig, historical: ScenarioReport,
  evidenceFile: string, directory: string) {
  const definition = config.scenarios.find(s => s.id === historical.id);
  if (!definition || historical.callResults?.length || historical.mcpTool !== 'whatap_query_data' ||
      !historical.candidate.file || !historical.candidate.args || !historical.mcpPath)
    throw Error('이 Harness 결함의 독립 재현 기준이 없습니다.');
  const scenario = definition;
  const periodMissing = historical.reason === 'MCP_PERIOD_MISSING_OR_INVALID' && historical.status === 'UNVERIFIABLE';
  if (!periodMissing && (historical.status !== 'FAIL' || !historical.reference.file))
    throw Error('이 Harness 결함의 독립 재현 기준이 없습니다.');
  const plan = { scenarioId: scenario.id,
    relativeReplay: { originalArgs: historical.candidate.args!, mcpPath: historical.mcpPath! } };
  const args = relativeReplayArgs(plan.relativeReplay);
  if (args.projectCode !== scenario.projectCode || !(scenario.allowedMcpPaths ?? [scenario.mcpPath]).includes(historical.mcpPath!))
    throw Error('이 Harness 결함의 독립 재현 기준이 없습니다.');
  const raw = await readFile(resolve(dirname(evidenceFile), historical.candidate.file));
  if (hashed(raw) !== historical.candidate.sha256) throw Error('저장된 MCP 원본이 변경되었습니다.');
  const saved = JSON.parse(raw.toString()) as McpToolResult;
  const tools = [{ name: 'whatap_query_data', inputSchema: { properties: { timeRange: { type: 'string' } } } }];

  // Runs the unchanged and candidate implementations over the same recorded observation.
  // The controller owns the HTTP calls, replay inputs, and acceptance checks.
  async function replay(dist: string, input: Call, expected: Call[], schema: unknown) {
    const outputDir = await mkdtemp(join(directory, 'harness-replay-'));
    const driver = join(outputDir, 'replay.mjs');
    const fixture = join(outputDir, 'fixture.json');
    await writeFile(driver, runner, { mode: 0o600 });
    await writeFile(fixture, JSON.stringify({ config: { ...config, outputDir, servers: {
      candidate: 'candidate', reference: 'reference',
    } }, options: plan, candidate: input, reference: expected, tools: schema }), { mode: 0o600 });
    const execution = await localCommand(process.execPath, ['--permission',
      `--allow-fs-read=${dist}`, `--allow-fs-read=${join(dirname(dist), 'package.json')}`,
      `--allow-fs-read=${outputDir}`, `--allow-fs-write=${outputDir}`, driver, dist, fixture], outputDir, 60_000);
    if (!execution.ok) throw Error('격리된 Harness 재생 실행 실패: ' + execution.stderr);
    const { runDir, trace } = JSON.parse(await readFile(join(outputDir, 'result.json'), 'utf8'));
    const path = await realpath(resolve(runDir, 'report.json'));
    if (!path.startsWith(outputDir + sep) || trace.candidate !== 1 || trace.reference !== expected.length || trace.unexpected)
      throw Error('Harness가 사전에 고정한 재생 요청과 다르게 실행했습니다.');
    const report = JSON.parse(await readFile(path, 'utf8')) as RunReport;
    const row = report.scenarios[0];
    if (report.scenarios.length !== 1 || row?.id !== scenario.id || row.projectCode !== scenario.projectCode ||
        !isDeepStrictEqual(row.candidate.args, args))
      throw Error('Harness 재생 결과의 시나리오 또는 원본 인자가 다릅니다.');
    const candidatePath = await realpath(resolve(runDir, row.candidate.file!));
    if (!candidatePath.startsWith(dirname(path) + sep)) throw Error('MCP 재생 증거가 실행 디렉터리 밖에 있습니다.');
    const candidate = await readFile(candidatePath);
    if (hashed(candidate) !== row.candidate.sha256 || !isDeepStrictEqual(JSON.parse(candidate.toString()), input.result))
      throw Error('Harness 재생 결과의 MCP 원본이 다릅니다.');
    return { path, row };
  }
  const historicalCall = { tool: 'whatap_query_data', args, result: saved };
  async function compare(input: Call, label: string) {
    const text = input.result.content?.find(block => block.type === 'text')?.text;
    const structured = input.result.structuredContent as { stime: number; etime: number } | undefined;
    const parsed = typeof text === 'string' ? parseFormattedMcp(text, [...(scenario.matchKeys ?? []), ...(scenario.compareFields ?? [])]) : null;
    const window = structured ?? (!periodMissing && parsed?.ok ? parsed.data.period : undefined);
    if (input.result.isError || !parsed?.ok || !window || !Number.isSafeInteger(window.stime) ||
        !Number.isSafeInteger(window.etime) || window.stime <= 0 || window.etime <= window.stime ||
        window.etime - window.stime !== expectedDurationMs(String(args.timeRange)) ||
        parsed.data.period.stime !== Math.floor(window.stime / 1000) * 1000 ||
        parsed.data.period.etime !== Math.floor(window.etime / 1000) * 1000 ||
        !parsed.data.rows.every(row => isWithinTimeWindow({ ...scenario, ...window }, row.time)))
      throw Error('저장 또는 실시간 MCP 응답의 Markdown/절대 기간을 독립적으로 교차 확인하지 못했습니다.');
    const data = { ...parsed.data, period: { ...parsed.data.period, stime: window.stime, etime: window.etime } };
    const reference = new StdioMcpClient(config.servers.reference, config.rpcTimeoutMs);
    const calls: Call[] = [];
    let verdict: { status: string; reason: string };
    const call = async (tool: string, time: { stime: number; etime: number }, extra = {}) => {
      const request = { projectCode: scenario.projectCode, stime: time.stime, etime: time.etime, ...extra };
      const result = await reference.callTool(tool, request);
      calls.push({ tool, args: request, result });
      if (result.isError) throw Error('독립 HTTP 도구가 오류를 반환했습니다.');
      return extractContent(result);
    };
    const receipt = join(directory, `${label}.json`);
    try {
      await reference.start();
      if (scenario.statisticsMode) {
        const mxql = await call('whatap_http_mxql_path', window, { path: historical.mcpPath });
        const v2 = await call(scenario.referenceTool, alignedStatsWindow(window.stime, window.etime));
        verdict = analyzeStats(scenario, data, text!, mxql, v2);
      } else {
        async function compareWindow(time: { stime: number; etime: number }) {
          const effective = { ...scenario, ...time };
          const payload = await call(scenario.referenceTool, time);
          const assessment = assessReference(effective, payload, { skipStepCoverage: true });
          if (!assessment.complete || !assessment.rows || !verifyReferenceRequest(effective, payload).ok)
            throw Error('독립 HTTP 응답의 요청 범위 또는 완전성을 확인하지 못했습니다.');
          const result = compareSubset(scenario, assessment.rows, data.rows);
          const summary = checkSummary(text!, scenario, assessment.rows, data.rows);
          return { result: summary.ok ? result : { status: 'FAIL', reason: 'MCP_SUMMARY_MISMATCH' }, rows: assessment.rows };
        }
        const initial = await compareWindow(window);
        verdict = initial.result;
        if (verdict.reason === 'MISSING_OR_EXTRA_RECORDS' &&
            isBoundaryOnlyShift({ ...scenario, ...window }, initial.rows, data.rows)) {
          for (const delta of [1, 1000]) {
            const attempt = await compareWindow({ stime: window.stime + delta, etime: window.etime + delta });
            if (attempt.result.status === 'PASS') {
              verdict = { status: 'PASS', reason: 'MATCHING_DATA_BOUNDARY_REALIGNED' };
              break;
            }
          }
        }
      }
    } finally {
      await reference.close();
      await writeFile(receipt, JSON.stringify({ input, calls }, null, 2), { flag: 'wx', mode: 0o600 });
    }
    if (verdict.status !== 'PASS') throw Error(`독립 HTTP 비교 실패 ${scenario.id} · ${verdict.reason} · ${receipt}`);
    return { window: { stime: window.stime, etime: window.etime }, calls, verdict, receipt, rowCount: data.rows.length };
  }

  const historicalComparison = periodMissing ? undefined : await compare(historicalCall, 'historical');
  const before = await replay(dirname(fileURLToPath(import.meta.url)), historicalCall, historicalComparison?.calls ?? [], tools);
  if (before.row.status !== historical.status || before.row.reason !== historical.reason ||
      (periodMissing && before.row.reference.file))
    throw Error('실행 중인 Harness에서 저장된 실패를 재현하지 못했습니다.');

  return { before, needsLiveCandidate: true, async verify(dist: string, candidateEntry: string) {
    const liveClient = new StdioMcpClient(candidateEntry, config.rpcTimeoutMs);
    let live: Call;
    let liveTools;
    try {
      await liveClient.start();
      liveTools = await liveClient.listTools();
      live = { ...historicalCall, result: await liveClient.callTool(historicalCall.tool, args) };
    } finally {
      await liveClient.close();
    }
    const results = [];
    for (const [label, input, schema] of [['historical', historicalCall, tools], ['live', live, liveTools]] as const) {
      const expected = label === 'historical' && historicalComparison ? historicalComparison : await compare(input, label);
      const after = await replay(dist, input, expected.calls, schema);
      if (after.row.status !== 'PASS' || after.row.reason !== expected.verdict.reason ||
          !isDeepStrictEqual(after.row.timeWindow, expected.window) ||
          !after.row.candidate.period || after.row.candidate.parsedRows !== expected.rowCount)
        throw Error(`수정 Harness 판정이 독립 검증과 다릅니다 · ${scenario.id} · ${label} · ${after.path} · ${expected.receipt}`);
      const metas = [after.row.reference.statistics?.mxql,
        after.row.reference.boundaryAlignment?.original ?? after.row.reference,
        ...(after.row.reference.boundaryAlignment?.attempts ?? [])].filter(Boolean);
      if (metas.length !== expected.calls.length) throw Error('수정 Harness의 독립 HTTP 증거가 누락되었습니다.');
      for (const [i, meta] of metas.entries()) {
        const path = await realpath(resolve(dirname(after.path), meta!.file!));
        if (!path.startsWith(dirname(after.path) + sep)) throw Error('HTTP 재생 증거가 실행 디렉터리 밖에 있습니다.');
        const bytes = await readFile(path);
        if (hashed(bytes) !== meta!.sha256 || !isDeepStrictEqual(JSON.parse(bytes.toString()), expected.calls[i].result))
          throw Error('수정 Harness가 기록한 HTTP 원본이 독립 조회와 다릅니다.');
      }
      results.push({ label, after, independent: expected.verdict, evidence: expected.receipt,
        evidenceSha256: hashed(await readFile(expected.receipt)) });
    }
    return results;
  } };
}
