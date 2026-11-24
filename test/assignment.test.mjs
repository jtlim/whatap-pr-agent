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
import { alignedStatsWindow } from '../dist/statistics.js';
import { start, end, ftime, markdown, rows, v2Stats } from './mock-statistics-data.mjs';

const sourceConfig = JSON.parse(await readFile(new URL('./fixtures/harness.json', import.meta.url)));
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

// Model the saved comparison report and its raw responses without using service data.
async function savedF8Evidence(options) {
  const directory = join(options.worktree, '..', 'f8-evidence');
  const runDir = join(directory, 'runs', 'fixture-run');
  await mkdir(runDir, { recursive: true });
  const timeWindow = { stime: start, etime: end };
  const raw = async (file, value) => {
    const body = JSON.stringify(value);
    await writeFile(join(runDir, file), body);
    return { file, sha256: sha(body) };
  };
  const scenarios = await Promise.all(sourceConfig.scenarios.map(async scenario => {
    const { id, domain, projectCode, mcpPath, referenceTool, statisticsMode, compareFields } = scenario;
    const inconsistent = statisticsMode === 'transaction';
    const args = { projectCode, path: mcpPath, timeRange: '1h', limit: 1000 };
    const text = value => ({ content: [{ type: 'text', text: value }] });
    const http = body => text(JSON.stringify({ ok: true, status: 200, body }));
    const period = `${ftime(start)} → ${ftime(end)}`;
    const headings = ['time', '_id_', ...compareFields];
    const values = compareFields.map(() => 1);
    const visible = statisticsMode ? rows(statisticsMode).slice(0, 4) : [];
    const candidateText = statisticsMode ? markdown(statisticsMode, visible) : [
      `## ${mcpPath}`, '', `**Period**: ${period}`, '',
      `| ${headings.join(' | ')} |`,
      `| ${headings.map(() => '---').join(' | ')} |`,
      `| ${[ftime(start), 'fixture', ...values].join(' | ')} |`,
    ].join('\n');
    const candidate = await raw(`${id}-mcp.json`, text(candidateText));
    let reference;
    if (statisticsMode) {
      const fullRows = rows(statisticsMode);
      const data = v2Stats(statisticsMode, fullRows);
      if (inconsistent) data[0].count += 1;
      reference = await raw(`${id}-reference.json`, http({ data, total: data.length, retrievedTotal: data.length }));
      const mxql = await raw(`${id}-reference-mxql.json`, http([{ _head_: {} }, ...fullRows]));
      reference.statistics = { mxql, v2Window: alignedStatsWindow(start, end) };
    } else {
      const row = { time: start, _id_: 'fixture', ...Object.fromEntries(compareFields.map(field => [field, 1])) };
      reference = await raw(`${id}-reference.json`, http([{ _head_: {} }, row]));
    }
    return {
      id, domain, projectCode, mcpPath, referenceTool, mcpTool: 'whatap_query_data', timeWindow,
      status: inconsistent ? 'UNVERIFIABLE' : 'PASS',
      reason: inconsistent ? 'REFERENCE_INCONSISTENCY' : 'PASS',
      checks: statisticsMode ? [{ code: 'STATS_AGGREGATE', ok: !inconsistent,
        detail: inconsistent ? 'Synthetic aggregate differs from the matching MXQL rows' : 'Synthetic aggregates match' }] : [],
      candidate: { ...candidate, args }, reference,
    };
  }));
  const reportPath = join(runDir, 'report.json');
  await writeFile(reportPath, JSON.stringify({ runDir, scenarios, totals: { PASS: 4, UNVERIFIABLE: 1 } }));
  return { directory, reportPath };
}

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
  await git(repo, 'remote', 'add', 'origin', 'https://github.com/jtlim/whatap-open-mcp.git');
  const servers = {
    candidate: resolve('test', sourceConfig.servers.candidate),
    reference: resolve('test', sourceConfig.servers.reference),
  };
  await writeFile(configPath, JSON.stringify({ ...sourceConfig, servers, rpcTimeoutMs: 1000 }));
  return { configPath, worktree, allowGitSubmit: false };
}

test('F8 reference inconsistency and all PASS scenarios reach analysis from hashed evidence', async t => {
  const options = await fixture(t);
  options.evidencePath = (await savedF8Evidence(options)).directory;
  const report = await runAssignment(options, {
    analyze: async (_, prompt) => {
      assert.match(prompt, /REFERENCE_INCONSISTENCY/);
      assert.match(prompt, /apm-transaction-stats-reference-mxql\.json/);
      const saved = await loadEvidence(prompt.match(/전체 (?:비교 보고서|report\.json) (.*)/)[1]);
      assert.deepEqual(saved.scenarios.map(r => r.status), ['PASS', 'UNVERIFIABLE', 'PASS', 'PASS', 'PASS']);
      assert.equal(Object.keys(saved.files).length, 12);
      assert.equal(saved.sha256, sha(await readFile(saved.path)));
      return diagnose('API_OR_BACKEND_ISSUE');
    },
    snapshot: snapshotWorktree,
  });
  assert.equal(report.status, 'UNVERIFIABLE');
  assert.equal(report.diagnoses[1].classification, 'API_OR_BACKEND_ISSUE');
  assert.equal(report.changes.length, 0);
  assert.match(await readFile(join(report.directory, 'assignment.md'), 'utf8'), /REFERENCE_INCONSISTENCY/);

  const mxql = Object.keys(report.before.files).find(file => file.endsWith('apm-transaction-stats-reference-mxql.json'));
  await writeFile(mxql, '{}');
  await assert.rejects(loadEvidence(report.before.path), /SHA-256 불일치/);
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
  const options = { ...await fixture(t), allowGitSubmit: true };
  options.evidencePath = (await savedF8Evidence(options)).directory;
  const report = await runAssignment(options, {
    snapshot: snapshotWorktree,
    analyze: async () => { throw Error('mock Codex authentication failed'); },
    submit: async () => assert.fail('Git was invoked'),
  });
  assert.equal(report.status, 'AI_EXECUTION_FAILED');
  assert.match(report.reason, /mock Codex authentication failed/);
  assert.equal(report.before.scenarios.length, 5);
  assert.equal(report.git.status, '미실행');
  const json = JSON.parse(await readFile(join(report.directory, 'assignment.json'), 'utf8'));
  assert.equal(json.status, 'AI_EXECUTION_FAILED');
  assert.match(await readFile(join(report.directory, 'assignment.md'), 'utf8'), /AI_EXECUTION_FAILED/);
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
  const options = await fixture(t);
  options.evidencePath = (await savedF8Evidence(options)).directory;
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

test('Harness responsibility uses its own worktree and leaves pending MCP changes intact', async t => {
  const options = { ...await fixture(t), allowGitSubmit: true };
  const root = resolve(options.worktree, '..');
  const harnessRepo = join(root, 'harness-original');
  const harnessWorktree = join(root, 'harness-agent');
  await mkdir(join(harnessRepo, 'src'), { recursive: true });
  await writeFile(join(harnessRepo, 'src/agent.ts'), 'export const value = 1;\n');
  await git(harnessRepo, 'init', '-b', 'submission');
  await git(harnessRepo, 'add', '.');
  await git(harnessRepo, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'base');
  await git(harnessRepo, 'worktree', 'add', '-b', 'agent', harnessWorktree);
  const mcpFile = join(options.worktree, 'src/query.ts');
  await writeFile(mcpFile, 'export const queryData = 2;\n');
  const directory = join(root, 'prior');
  await mkdir(directory);
  const { reportPath } = await savedF8Evidence(options);
  const assumed = await loadEvidence(reportPath);
  const rows = assumed.scenarios.map(row => ({ ...row, candidate: { args: row.candidate.args },
    reference: {}, reason: 'MCP_PERIOD_MISSING_OR_INVALID', status: 'UNVERIFIABLE' }));
  const baseline = JSON.stringify({ scenarios: rows });
  await writeFile(join(directory, 'baseline.json'), baseline);
  await writeFile(join(directory, 'assignment.json'), JSON.stringify({ before: { sha256: sha(baseline) } }));
  const evidencePath = join(directory, 'assignment.md');
  await writeFile(evidencePath, '# 이전 과제');
  const fakeEntry = join(root, 'stage/dist/agent.js');
  await mkdir(resolve(fakeEntry, '..'), { recursive: true });
  await writeFile(fakeEntry, 'fixture');
  let submitted = false;
  const report = await runAssignment({ ...options, harnessWorktree, evidencePath }, {
    analyze: async () => {
      const answer = diagnose('MCP_DEFECT');
      answer.diagnoses.push({ ...answer.diagnoses[1], classification: 'HARNESS_DEFECT', files: ['src/agent.ts'] });
      return answer;
    },
    checkRepository: async (tree, target) => {
      assert.equal(tree, harnessWorktree);
      assert.equal(target, 'harness');
    },
    reproduceHarness: async (_config, row, path) => ({
      before: { path, row },
      verify: async (dist, candidate) => {
        assert.equal(dist, join(root, 'stage/dist'));
        assert.equal(candidate, 'mcp-build');
        return [];
      },
    }),
    edit: async (tree, prompt) => {
      assert.equal(tree, harnessWorktree);
      assert.match(prompt, /baseline\.json/);
      await writeFile(join(tree, 'src/agent.ts'), 'export const value = 2;\n');
      return { summary: '변경', rationale: '재현', risks: [], testsRun: [] };
    },
    prepare: async (tree, _dir, _edit, _attempt, regression, _copy, inputs) => {
      if (tree === harnessWorktree) {
        assert.equal(regression, true);
        assert.equal(inputs.entry, 'agent.js');
      } else assert.equal(tree, options.worktree);
      return { candidate: tree === harnessWorktree ? fakeEntry : 'mcp-build', build: { ok: true }, regression: { ok: true } };
    },
    submit: async (tree, _head, changes, receipt, check, target) => {
      assert.equal(tree, harnessWorktree);
      assert.equal(target, 'harness');
      assert.equal(changes[0].before, 'export const value = 1;\n');
      await check();
      receipt.pr = 'https://github.com/jtlim/whatap-pr-agent/pull/1';
      submitted = true;
    },
  });
  assert.equal(report.status, 'VERIFIED', report.reason);
  assert.equal(report.repository, 'jtlim/whatap-pr-agent');
  assert.ok(report.related.deferred);
  assert.equal(submitted, true);
  assert.equal(await readFile(mcpFile, 'utf8'), 'export const queryData = 2;\n');
  assert.equal(await readFile(evidencePath, 'utf8'), '# 이전 과제');
});

test('MCP resume waits for the preceding Harness PR and preserves the pending work on rejection', async t => {
  const options = await fixture(t);
  const goalPath = join(options.worktree, '..', 'goal.md');
  const source = join(options.worktree, 'src/query.ts');
  const pending = 'export const queryData = 2;\n';
  await writeFile(goalPath, '# 기존 절대시간 조회 개선');
  await writeFile(source, pending);
  const resumeMcpAfter = 'https://github.com/jtlim/whatap-pr-agent/pull/5';
  const report = await runAssignment({ ...options, goalPath, resumeMcpAfter, evidencePath: (await savedF8Evidence(options)).directory, allowGitSubmit: true }, {
    approval: async pr => {
      assert.equal(pr, resumeMcpAfter);
      throw Error('선행 PR 병합 미확인');
    },
    analyze: async () => assert.fail('MCP resume analyzed before approval'),
    edit: async () => assert.fail('MCP resume invoked the editor'),
    prepare: async () => assert.fail('MCP resume built before approval'),
    submit: async () => assert.fail('MCP resume submitted before approval'),
  });
  assert.equal(report.status, 'UNVERIFIABLE');
  assert.match(report.reason, /선행 PR 병합 미확인/);
  assert.equal(await readFile(source, 'utf8'), pending);
});

test('approved MCP resume checks committed schema separately from the pending candidate', async t => {
  const options = await fixture(t);
  const goalPath = join(options.worktree, '..', 'goal.md');
  const source = join(options.worktree, 'src/query.ts');
  const pending = 'export const queryData = 2;\n';
  await writeFile(goalPath, '# 기존 절대시간 조회 개선');
  await writeFile(source, pending);
  const resumeMcpAfter = 'https://github.com/jtlim/whatap-pr-agent/pull/5';
  let reads = 0;
  const report = await runAssignment({ ...options, goalPath, resumeMcpAfter, evidencePath: (await savedF8Evidence(options)).directory }, {
    approval: async pr => ({ pr, commit: 'a'.repeat(40) }),
    analyze: async () => assert.fail('MCP resume invoked analysis'),
    edit: async () => assert.fail('MCP resume invoked the editor'),
    prepare: async (tree, dir, _edit, _attempt, regression) => {
      const committed = tree !== options.worktree;
      assert.equal(await readFile(join(tree, 'src/query.ts'), 'utf8'), committed ? 'export const queryData = 1;\n' : pending);
      const candidate = join(dir, committed ? 'committed.js' : 'pending.js');
      await writeFile(candidate, 'fixture');
      return { candidate, build: { ok: true }, regression: { ok: regression } };
    },
    verify: async (config, request) => {
      const runDir = join(config.outputDir, `resume-evidence-${++reads}`);
      await mkdir(runDir);
      const file = 'raw.json';
      const body = JSON.stringify({ value: 3 });
      await writeFile(join(runDir, file), body);
      const definition = config.scenarios.find(s => s.id === request.scenarioId);
      const fixed = request.fixedReplay;
      const legacy = fixed && config.servers.candidate.endsWith('committed.js');
      const timeWindow = fixed?.window ?? { stime: 1795481448234, etime: 1795485048234 };
      const original = (fixed ?? request.relativeReplay).originalArgs;
      const args = { ...original };
      if (fixed) {
        delete args.timeRange;
        Object.assign(args, fixed.window);
      }
      const evidence = { file, sha256: sha(body) };
      const row = { id: definition.id, projectCode: definition.projectCode, mcpPath: args.path,
        mcpTool: 'whatap_query_data', timeWindow, status: legacy ? 'UNVERIFIABLE' : 'PASS',
        reason: legacy ? 'FIXED_REPLAY_SCHEMA_NOT_SUPPORTED' : 'PASS',
        candidate: { ...evidence, args }, reference: evidence, checks: [] };
      const disk = { runDir, scenarios: [row], ...(fixed ? {
        fixedReplayAudit: { toolCalls: legacy ? 0 : 1, schemaVerdict: legacy ? 'NO_EXPLICIT_WINDOW' : 'SCHEMA_CANDIDATE',
          periodMatched: !legacy, requestedWindow: timeWindow },
      } : { relativeReplayAudit: { toolCalls: 1, schemaVerified: true, periodObserved: true } }) };
      await writeFile(join(runDir, 'report.json'), JSON.stringify(disk));
      return disk;
    },
    submit: async () => assert.fail('MCP resume submitted without authorization'),
  });
  assert.equal(report.status, 'VERIFIED', report.reason);
  assert.equal(report.absoluteChecks.length, 5);
  assert.equal(report.related.approval.pr, resumeMcpAfter);
  assert.equal(await readFile(source, 'utf8'), pending);
});
