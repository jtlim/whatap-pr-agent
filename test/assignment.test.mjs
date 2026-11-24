import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { loadEvidence, parseAnalysis, runAssignment } from '../dist/assignment.js';
import { runAgentHarness } from '../dist/agent.js';
import { StdioMcpClient } from '../dist/mcp.js';
import { codexReadOnly } from '../dist/phasec.js';
import { codexEdit, snapshotWorktree } from '../dist/phasec2.js';

const f8 = resolve('runs/f8-e2e/full-20261124T015004Z');
const sourceConfig = JSON.parse(await readFile('config/harness.json'));
const ids = sourceConfig.scenarios.map(s => s.id);
const diagnose = (classification, scenarioId = 'apm-transaction-stats') => ({
  queries: [],
  diagnoses: ids.map(id => ({
    scenarioId: id, classification: id === scenarioId ? classification : 'NO_DEFECT',
    cause: '원인', basis: '실측 근거', change: '변경 이유', limitations: '관측 범위', functions: 'queryData',
    files: id === scenarioId ? ['src/query.ts'] : [],
  })),
});
const sha = value => createHash('sha256').update(value).digest('hex');
const git = (cwd, ...args) => promisify(execFile)('git', args, { cwd });

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'harness-assignment-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'harness');
  const repo = join(temp, 'original');
  const worktree = join(temp, 'agent');
  const configPath = join(root, 'config', 'harness.json');
  await mkdir(join(root, 'config'), { recursive: true });
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src/query.ts'), 'export const queryData = 1;\n');
  await git(repo, 'init', '-b', 'submission');
  await git(repo, 'add', '.');
  await git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'base');
  await git(repo, 'worktree', 'add', '-b', 'agent', worktree);
  await writeFile(configPath, JSON.stringify({ ...sourceConfig, outputDir: 'runs', rpcTimeoutMs: 1000 }));
  return { configPath, worktree, allowGitSubmit: false };
}

test('F8 reference inconsistency and all PASS scenarios reach analysis from hashed evidence', async t => {
  const options = { ...await fixture(t), evidencePath: f8 };
  const report = await runAssignment(options, {
    analyze: async (_, prompt) => {
      assert.match(prompt, /REFERENCE_INCONSISTENCY/);
      assert.match(prompt, /apm-transaction-stats-reference-mxql\.json/);
      const saved = await loadEvidence(prompt.match(/전체 (?:비교 보고서|report\.json) (.*)/)[1]);
      assert.deepEqual(saved.scenarios.map(r => r.status), ['PASS', 'UNVERIFIABLE', 'PASS', 'PASS', 'PASS']);
      return diagnose('API_OR_BACKEND_ISSUE');
    },
    snapshot: snapshotWorktree,
  });
  assert.equal(report.status, 'UNVERIFIABLE');
  assert.equal(report.diagnoses[1].classification, 'API_OR_BACKEND_ISSUE');
  assert.equal(report.changes.length, 0);
  assert.match(await readFile(join(report.directory, 'assignment.md'), 'utf8'), /REFERENCE_INCONSISTENCY/);
});

test('additional HTTP requests are bounded and reject arbitrary tools and query arguments', () => {
  const request = { scenarioId: ids[1], source: 'mxql', stime: Date.now() - 3600000, etime: Date.now() - 1 };
  const answer = { ...diagnose('INSUFFICIENT_EVIDENCE'), queries: [request] };
  assert.deepEqual(parseAnalysis(answer, sourceConfig, true).queries, [request]);
  assert.throws(() => parseAnalysis(answer, sourceConfig, false));
  assert.throws(() => parseAnalysis({ ...answer, queries: [{ ...request, url: 'https://example.org' }] }, sourceConfig, true));
  assert.throws(() => parseAnalysis({ ...answer, queries: [{ ...request, stime: request.stime - 86400000 }] }, sourceConfig, true));
});

test('F8 analysis failure produces local JSON and Markdown without Git submission', async t => {
  const options = { ...await fixture(t), evidencePath: f8, allowGitSubmit: true };
  const report = await runAssignment(options, {
    snapshot: snapshotWorktree,
    analyze: async () => { throw Error('mock Codex authentication failed'); },
    submit: async () => assert.fail('Git was invoked'),
  });
  assert.equal(report.status, 'AI_EXECUTION_FAILED');
  assert.match(report.reason, /mock Codex authentication failed/);
  assert.equal(report.before.scenarios.length, 5);
  assert.equal(report.git.status, '미실행');
});

test('assignment schemas are accepted by the existing read-only and edit subprocess wrappers', async t => {
  const options = await fixture(t);
  const bin = join(options.worktree, '..', 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'codex'), `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv;
const schema = JSON.parse(fs.readFileSync(argv[argv.indexOf('--output-schema') + 1]));
const response = schema.properties.diagnoses ? ${JSON.stringify(diagnose('NO_DEFECT'))} :
  {summary:'수정', rationale:'이유', risks:[], testsRun:[]};
fs.writeFileSync(argv[argv.indexOf('--output-last-message') + 1], JSON.stringify(response));
`, { mode: 0o700 });
  const old = process.env.PATH;
  process.env.PATH = `${bin}:${old}`;
  t.after(() => { process.env.PATH = old; });
  const dir = join(options.worktree, '..', 'out', 'tasks', 'task-00000000-00000001');
  await mkdir(dir, { recursive: true });
  const output = await codexReadOnly(options.worktree, 'test', dir, { properties: { diagnoses: {} } });
  assert.equal(output.diagnoses.length, 5);
  const edit = await codexEdit(options.worktree, 'test', dir, 1);
  assert.equal(edit.summary, '수정');
});

function mockAbsoluteTransport(t, mode) {
  const stime = Date.parse('2026-11-22T16:09:46Z');
  const rowTime = Date.parse('2026-11-22T16:09:51Z');
  const text = body => ({ content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) }] });
  t.mock.method(StdioMcpClient.prototype, 'start', async () => {});
  t.mock.method(StdioMcpClient.prototype, 'listTools', async function () {
    return [{ name: 'whatap_query_data', inputSchema: { type: 'object', properties: {
      timeRange: { type: 'string' },
      ...(this.entry.endsWith('baseline.js') ? {} : { stime: { type: 'number' }, etime: { type: 'number' } }),
    } } }];
  });
  t.mock.method(StdioMcpClient.prototype, 'callTool', async function (tool, args) {
    assert.equal(args.stime, stime);
    assert.equal(args.etime, stime + 300_000);
    if (tool === 'whatap_query_data') {
      assert.ok(!this.entry.endsWith('baseline.js'));
      assert.equal(args.path, 'v2/sys/server_base');
      assert.equal(args.timeRange, undefined);
      const date = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
      const offset = mode === 'wrong-period' ? 1000 : 0;
      return text([
        '## v2/sys/server_base', '',
        `**Period**: ${date(args.stime + offset)} → ${date(args.etime + offset)}`, '',
        '| time | _id_ | _name_ | cpu (%) | memory_pused (%) |',
        '| --- | --- | --- | --- | --- |',
        `| ${date(rowTime)} | 1 | srv1 | ${mode === 'bad-data' ? '99.99' : '8.10'} | 60.20 |`,
      ].join('\n'));
    }
    assert.equal(tool, 'whatap_http_server_metrics');
    return text({
      ok: true, status: 200,
      body: [{ _head_: { 'cpu$': 'P', 'memory_pused$': 'P' } },
        { time: rowTime, _id_: '1', _name_: 'srv1', cpu: 8.1, memory_pused: 60.2 }],
      request: { method: 'POST', path: '/open/api/flush/mxql/path', projectCode: args.projectCode,
        payload: { stime: args.stime, etime: args.etime, mql: '/v2/sys/server_base' } },
    });
  });
}

async function simulateEdit(t, finalVerdict, initialVerdict = 'FAIL', allowGitSubmit = false, absoluteMode) {
  const options = { ...await fixture(t), allowGitSubmit };
  let madeBuild = 0;
  let submitted = 0;
  let queries = 0;
  const target = absoluteMode ? ids[0] : ids[1];
  const goal = '# 고정 기간 조회 목표';
  if (absoluteMode) {
    options.goalPath = join(options.worktree, '..', 'goal.md');
    await writeFile(options.goalPath, goal);
    mockAbsoluteTransport(t, absoluteMode);
  }
  const report = await runAssignment(options, {
    snapshot: snapshotWorktree,
    analyze: async (_, prompt) => {
      const initial = await loadEvidence(prompt.match(/전체 (?:비교 보고서|report\.json) (.*)/)[1]);
      assert.equal(initial.scenarios.find(s => s.id === target).status, initialVerdict);
      if (absoluteMode) {
        assert.ok(initial.scenarios.every(row => row.status === 'PASS'));
        assert.ok(prompt.includes(goal));
        return { ...diagnose('MCP_DEFECT', target), absoluteReplay: [target] };
      }
      return diagnose('MCP_DEFECT');
    },
    edit: async (worktree, prompt) => {
      if (absoluteMode) assert.ok(prompt.includes(goal));
      await writeFile(join(worktree, 'src/query.ts'), 'export const queryData = 2;\n');
      return { summary: '수정', rationale: '근거', testsRun: [], risks: [] };
    },
    prepare: async (_worktree, stageDir, _edit, _attempt, regression) => {
      madeBuild++;
      const candidate = join(stageDir, madeBuild === 1 ? 'baseline.js' : 'index.js');
      await writeFile(candidate, 'fixture');
      return { candidate, stageDir, build: { ok: true }, regression: { ok: regression, exitCode: regression ? 0 : null } };
    },
    verify: async (cfg, options) => {
      if (options.fixedReplay) {
        assert.ok(absoluteMode);
        assert.deepEqual(options.fixedReplay.window, {
          stime: Date.parse('2026-11-22T16:09:46Z'), etime: Date.parse('2026-11-22T16:14:46Z'),
        });
        return runAgentHarness({
          ...cfg, servers: { ...cfg.servers, reference: resolve('test/mock-f1b-reference.mjs') },
        }, options, () => {});
      }
      const id = options.scenarioId;
      assert.ok(options.relativeReplay);
      const original = madeBuild === 1;
      const runDir = join(cfg.outputDir, `observation-${++queries}`);
      await mkdir(runDir);
      const body = JSON.stringify({ value: original ? 1 : 2 });
      await writeFile(join(runDir, 'mcp.json'), body);
      await writeFile(join(runDir, 'http.json'), body);
      const file = path => ({ file: path, sha256: sha(body) });
      const timeWindow = { stime: 1795481448000, etime: 1795485048000 };
      if (absoluteMode) {
        timeWindow.stime = Date.parse('2026-11-22T16:10:46Z');
        timeWindow.etime = Date.parse('2026-11-22T16:15:46Z');
      }
      const args = options.relativeReplay.originalArgs;
      const status = id === target ? (original ? initialVerdict : finalVerdict) : 'PASS';
      const disk = {
        runDir,
        scenarios: [{ id, projectCode: args.projectCode, mcpPath: args.path, mcpTool: 'whatap_query_data',
          status, reason: status === 'UNVERIFIABLE' ? 'REFERENCE_INCONSISTENCY' : status, timeWindow, checks: [],
          candidate: { ...file('mcp.json'), args }, reference: file('http.json') }],
        relativeReplayAudit: { toolCalls: 1, schemaVerified: true, periodObserved: true, observedWindow: timeWindow },
      };
      await writeFile(join(runDir, 'report.json'), JSON.stringify(disk));
      return disk;
    },
    lookup: async () => assert.fail('Unexpected HTTP lookup'),
    submit: async (_worktree, _head, _changes, receipt, assertVerifiedSource) => {
      await assertVerifiedSource();
      submitted++;
      receipt.status = 'PR 확인 완료';
    },
  });
  assert.equal(submitted, allowGitSubmit && finalVerdict === 'PASS' && initialVerdict === 'FAIL' ? 1 : 0);
  assert.equal(madeBuild, 2, report.reason);
  assert.equal(queries, 10);
  assert.deepEqual(report.changes, [{ path: 'src/query.ts',
    before: 'export const queryData = 1;\n', after: 'export const queryData = 2;\n' }]);
  assert.equal(report.validation.length, 5);
  if (absoluteMode) {
    assert.equal(report.absoluteChecks[0]?.before.fixedReplayAudit.schemaVerdict, 'NO_EXPLICIT_WINDOW');
    assert.match(await readFile(join(report.directory, 'assignment.md'), 'utf8'), /고정 기간 조회 목표/);
  }
  return report;
}

test('AI edit is accepted only after five direct comparisons and the existing regression step', async t => {
  assert.equal((await simulateEdit(t, 'PASS')).status, 'VERIFIED');
});

test('AI edit with a failed independent comparison is reported as verification failure', async t => {
  assert.equal((await simulateEdit(t, 'FAIL', 'FAIL', true)).status, 'VERIFICATION_FAILED');
});

test('verified changes reach the submission adapter only with explicit authorization', async t => {
  assert.equal((await simulateEdit(t, 'PASS', 'FAIL', true)).git.status, 'PR 확인 완료');
});

test('MCP classification can lead from reference inconsistency to editing, without certifying an unproven fix', async t => {
  assert.equal((await simulateEdit(t, 'PASS', 'UNVERIFIABLE')).status, 'UNVERIFIABLE');
});

test('an allowed HTTP lookup returns raw evidence to the second analysis round', async t => {
  const options = { ...await fixture(t), evidencePath: f8 };
  let calls = 0;
  const query = { scenarioId: ids[1], source: 'mxql', stime: Date.now() - 3600000, etime: Date.now() - 100 };
  const report = await runAssignment(options, {
    lookup: async (config, saved, directory) => {
      const scenario = config.scenarios.find(s => s.id === saved.scenarioId);
      const tool = 'whatap_http_mxql_path';
      const args = { projectCode: scenario.projectCode, path: scenario.mcpPath, stime: saved.stime, etime: saved.etime };
      const file = join(directory, 'http-1.json');
      const body = JSON.stringify({ query: saved, tool, args, result: { content: [{type:'text',text:'mock raw response'}] } });
      await writeFile(file, body);
      return { query: saved, tool, args, file, sha256: sha(body) };
    },
    analyze: async (_worktree, prompt) => {
      if (++calls === 1) return { ...diagnose('INSUFFICIENT_EVIDENCE'), queries: [query] };
      assert.match(prompt, /최종 분석 회차/);
      const [evidence] = JSON.parse(prompt.match(/추가 조회 증거 (.*)/)[1]);
      const raw = JSON.parse(await readFile(evidence.file, 'utf8'));
      assert.equal(raw.tool, 'whatap_http_mxql_path');
      assert.equal(raw.result.content[0].text, 'mock raw response');
      assert.equal(raw.args.projectCode, sourceConfig.scenarios[1].projectCode);
      assert.equal(raw.args.path, sourceConfig.scenarios[1].mcpPath);
      assert.deepEqual(raw.query, query);
      return diagnose('INSUFFICIENT_EVIDENCE');
    },
  });
  assert.equal(report.status, 'UNVERIFIABLE', report.reason);
  assert.equal(calls, 2);
  assert.equal(report.lookups.length, 1);
});

test('all-PASS baseline reaches goal analysis and verifies an added absolute-time schema through offline MCP and HTTP', async t => {
  const report = await simulateEdit(t, 'PASS', 'PASS', false, 'supported');
  assert.equal(report.status, 'VERIFIED', report.reason);
  assert.equal(report.absoluteChecks[0].after.scenarios[0].status, 'PASS');
});

test('absolute-time schema alone cannot verify an edit that returns the wrong period', async t => {
  const report = await simulateEdit(t, 'PASS', 'PASS', false, 'wrong-period');
  assert.equal(report.status, 'UNVERIFIABLE', report.reason);
  assert.equal(report.absoluteChecks[0].after.scenarios[0].reason, 'FIXED_REPLAY_PERIOD_MISMATCH');
});

test('absolute-time edit must also pass the independent HTTP comparison', async t => {
  const report = await simulateEdit(t, 'PASS', 'PASS', false, 'bad-data');
  assert.equal(report.status, 'VERIFICATION_FAILED', report.reason);
  assert.equal(report.absoluteChecks[0].after.scenarios[0].status, 'FAIL');
});

test('an empty goal file is rejected before starting the assignment', async t => {
  const options = await fixture(t);
  options.goalPath = join(options.worktree, '..', 'empty.md');
  await writeFile(options.goalPath, '  \n');
  await assert.rejects(runAssignment(options), /사용자 목표 Markdown 파일이 비어 있습니다/);
});
