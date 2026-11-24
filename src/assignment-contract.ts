import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { HarnessVerificationFailure } from './assignment-harness.js';
import { localCommand } from './phased.js';
import type { HarnessConfig, ScenarioReport } from './types.js';

const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const delayMs = 1000;

// Runs the assignment coordinator with controlled observations. This driver and
// the acceptance checks come from the running Harness, outside the edit worktree.
const driver = `
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [dist, directory, mode] = process.argv.slice(2);
const monotonicNow = process.hrtime.bigint;
const copy = structuredClone;
const { runAssignment } = await import(pathToFileURL(join(dist, 'assignment.js')));
const { configPath, baseline, scenarioId, goalPath, worktree } =
  JSON.parse(await readFile(join(directory, 'input.json')));
const trace = [];
const snapshot = { files: {}, root: worktree, head: 'fixture', status: '', indexSha256: 'fixture' };
let edited = false;
const report = await runAssignment({ configPath, goalPath, worktree, allowGitSubmit: false,
  outputDir: join(directory, 'runs'), evidencePath: baseline }, {
  checkRepository: async () => {},
  snapshot: async () => edited ? { ...snapshot, status: ' M src/query.ts', files: { 'src/query.ts': 'file:fixture' } } : snapshot,
  analyze: async () => ({
    queries: [], absoluteReplay: [scenarioId],
    diagnoses: JSON.parse(await readFile(baseline)).scenarios.map(({ id }) => ({
      scenarioId: id, classification: id === scenarioId ? 'MCP_DEFECT' : 'NO_DEFECT',
      cause: 'fixture', basis: 'fixture', change: 'fixture', functions: 'fixture', limitations: 'fixture',
      files: id === scenarioId ? ['src/query.ts'] : [],
    })),
  }),
  edit: async () => { edited = true; return { summary: 'fixture', rationale: 'fixture', testsRun: [], risks: [] }; },
  prepare: async (_tree, _dir, _edit, _attempt, regression) => ({
    candidate: join(directory, regression ? 'after.js' : 'before.js'),
    build: { ok: true }, regression: { ok: true },
  }),
  verify: async (config, options) => {
    const { scenarioId: id, fixedReplay: fixed, relativeReplay: relative } = options;
    const candidate = config.servers.candidate.endsWith('/after.js');
    const calls = trace.filter(entry => entry.id === id && entry.candidate && entry.fixed).length;
    trace.push({ id, candidate, fixed: copy(fixed), elapsed: Number(monotonicNow() / 1000000n) });
    const legacy = fixed && !candidate;
    // Keep PASS and the audit flag in the drift case to test cross-checking of the returned window.
    const drift = fixed && candidate && calls === 1 && mode === 'drift';
    const mismatch = fixed && candidate && calls % 2 === 1 && mode === 'mismatch';
    const runDir = join(config.outputDir, 'fixture-' + trace.length);
    await mkdir(runDir);
    const evidence = JSON.parse(await readFile(baseline));
    const original = evidence.scenarios.find(row => row.id === id);
    const timeWindow = fixed ? (drift ? { ...fixed.window, etime: fixed.window.etime + 1 } : fixed.window) : original.timeWindow;
    const replayArgs = { ...(fixed ?? relative).originalArgs };
    if (fixed) {
      delete replayArgs.timeRange;
      Object.assign(replayArgs, fixed.window);
    }
    const raw = JSON.stringify({ value: 1 });
    await writeFile(join(runDir, 'raw.json'), raw);
    const meta = { file: 'raw.json', sha256: createHash('sha256').update(raw).digest('hex') };
    async function differentEvidence() {
      const file = 'http-mismatch.json';
      const bytes = JSON.stringify({ value: 2 });
      await writeFile(join(runDir, file), bytes);
      return { file, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    const row = { ...original, timeWindow, candidate: { ...meta, args: replayArgs }, reference: mismatch ? await differentEvidence() : meta,
      status: legacy || drift ? 'UNVERIFIABLE' : mismatch ? 'FAIL' : 'PASS',
      reason: legacy ? 'FIXED_REPLAY_SCHEMA_NOT_SUPPORTED' : drift ? 'FIXED_REPLAY_PERIOD_MISMATCH' :
        mismatch ? 'FIELD_MISMATCH' : 'MATCHING_DATA' };
    await writeFile(join(runDir, 'report.json'), JSON.stringify({ scenarios: [row], ...(fixed ? {
      fixedReplayAudit: { toolCalls: legacy ? 0 : 1, schemaVerdict: legacy ? 'NO_EXPLICIT_WINDOW' : 'SCHEMA_CANDIDATE',
        periodMatched: !legacy, requestedWindow: fixed.window },
    } : { relativeReplayAudit: { toolCalls: 1, schemaVerified: true, periodObserved: true } }) }));
    return { runDir };
  },
  submit: async () => { throw Error('Submission is disabled in the verification fixture'); },
});
await writeFile(join(directory, 'observation.json'), JSON.stringify({ status: report.status, reason: report.reason, trace }), { flag: 'wx' });
`;

type Observation = { status: string; reason: string; trace: Array<{
  id: string; candidate: boolean; fixed?: { originalArgs: unknown; mcpPath: string; window: { stime: number; etime: number } }; elapsed: number;
}> };

export async function reproduceAbsoluteValidation(config: HarnessConfig, historical: ScenarioReport, directory: string) {
  const definition = config.scenarios.find(row => row.id === historical.id);
  if (!definition || historical.status !== 'PASS' || historical.callResults?.length ||
      !historical.candidate.file || !historical.reference.file)
    throw Error('절대시간 검증 계약에는 기존 단일 조회의 MCP/HTTP PASS 증거가 필요합니다.');
  const scenarios = config.scenarios.map((scenario, i) => ({
    ...scenario, projectCode: i + 1, userRequest: undefined,
  }));
  const scenario = scenarios.find(row => row.id === historical.id)!;
  const args = { projectCode: scenario.projectCode, path: scenario.mcpPath, timeRange: '1h' };
  const window = { stime: 1_795_498_465_123, etime: 1_795_502_065_123 };
  const expectedWindow = { stime: window.stime - 60_000, etime: window.etime - 60_000 };
  const entry = join(directory, 'replay.mjs');
  await writeFile(entry, driver, { mode: 0o600 });

  async function observe(dist: string, label: string, mode: 'stable' | 'drift' | 'mismatch', evidenceDir = directory) {
    const target = join(evidenceDir, label);
    await mkdir(target, { mode: 0o700 });
    const runtime = join(evidenceDir, label + '-runtime');
    await mkdir(runtime, { mode: 0o700 });
    await Promise.all([
      cp(dist, join(runtime, 'dist'), { recursive: true }),
      mkdir(join(runtime, 'src')), mkdir(join(runtime, 'tools')),
      ...['package.json', 'package-lock.json', 'tsconfig.json'].map(name => cp(join(dirname(dist), name), join(runtime, name))),
    ]);
    const configPath = join(target, 'harness', 'config', 'harness.json');
    const worktree = join(target, 'mcp');
    await mkdir(dirname(configPath), { recursive: true });
    await mkdir(join(worktree, 'src'), { recursive: true });
    const write = (path: string, data: unknown) => writeFile(path, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
    const raw = { value: 1 };
    const meta = { file: 'raw.json', sha256: digest(JSON.stringify(raw)) };
    const baseline = join(target, 'baseline.json');
    const goalPath = join(target, 'goal.md');
    const reference = join(target, 'http', 'dist', 'index.js');
    await mkdir(dirname(reference), { recursive: true });
    await Promise.all([
      write(reference, 'fixture'), write(join(target, 'before.js'), 'fixture'), write(join(target, 'after.js'), 'fixture'),
      write(join(target, 'raw.json'), raw), write(join(worktree, 'src', 'query.ts'), 'fixture'),
      write(configPath, { ...config, scenarios, replayPolicy: 'PERIOD_PAIRED',
        servers: { candidate: join(target, 'before.js'), reference }, outputDir: join(target, 'runs') }),
      write(baseline, { scenarios: scenarios.map(s => ({
        id: s.id, projectCode: s.projectCode, mcpPath: s.mcpPath, mcpTool: 'whatap_query_data', timeWindow: window,
        status: 'PASS', reason: 'MATCHING_DATA', checks: [],
        candidate: { ...meta, args: { ...args, projectCode: s.projectCode, path: s.mcpPath } }, reference: meta,
      })) }),
      write(goalPath, '밀리초 절대시간 범위를 시간차를 두고 같은 인자로 재조회합니다.'),
      write(join(target, 'input.json'), { configPath, baseline, scenarioId: scenario.id, goalPath, worktree }),
    ]);
    const output = join(target, 'runs');
    const path = join(target, 'observation.json');
    await mkdir(output);
    const execution = await localCommand(process.execPath, ['--permission',
      `--allow-fs-read=${directory}`, `--allow-fs-read=${evidenceDir}`, `--allow-fs-write=${output}`, `--allow-fs-write=${path}`,
      entry, join(runtime, 'dist'), target, mode], target, 60_000);
    if (!execution.ok) throw Error('격리된 절대시간 검증 계약 실행 실패 · ' + execution.stderr);
    const observation = JSON.parse(await readFile(path, 'utf8')) as Observation;
    const baselineCalls = observation.trace.filter(call => call.fixed && !call.candidate);
    const calls = observation.trace.filter(call => call.fixed && call.candidate);
    const fixed = calls[0]?.fixed;
    const requested = fixed?.window;
    // Use observed calls and a monotonic clock. An audit count or a PASS alone is insufficient.
    const contractMet = baselineCalls.length === 1 && calls.length >= 2 &&
      [...baselineCalls, ...calls].every(call => call.id === historical.id && isDeepStrictEqual(call.fixed, fixed)) &&
      isDeepStrictEqual(fixed?.originalArgs, args) && fixed?.mcpPath === scenario.mcpPath &&
      isDeepStrictEqual(requested, expectedWindow) &&
      calls[1].elapsed - calls[0].elapsed >= delayMs;
    return { path, observation, contractMet };
  }

  const beforeDist = dirname(fileURLToPath(import.meta.url));
  const before = await observe(beforeDist, 'before-stable', 'stable');
  if (before.contractMet || before.observation.status !== 'VERIFIED')
    throw Error(`기존 데이터 비교는 통과하고 절대시간 검증 계약은 실패하는 기준을 재현하지 못했습니다. · ${before.path}`);
  return { before: { path: before.path, row: historical, sha256: digest(await readFile(before.path)) }, needsLiveCandidate: false, async verify(dist: string, _candidate: string, attemptDirectory: string) {
    const results = [];
    for (const mode of ['stable', 'drift', 'mismatch'] as const) {
      const after = await observe(dist, `after-${mode}`, mode, attemptDirectory);
      const accepted = mode === 'stable' ? after.observation.status === 'VERIFIED' :
        mode === 'drift' ? after.observation.status === 'UNVERIFIABLE' :
          after.observation.status === 'VERIFICATION_FAILED';
      if (!after.contractMet || !accepted) throw new HarnessVerificationFailure(`절대시간 독립 검증 계약 실패 · ${mode} · ${after.path}`, [after.path]);
      results.push({ label: mode, after: { path: after.path, row: historical }, independent: {
        status: 'PASS', reason: 'ABSOLUTE_VALIDATION_CONTRACT',
      }, evidence: after.path, evidenceSha256: digest(await readFile(after.path)), synthetic: true });
    }
    return results;
  } };
}
