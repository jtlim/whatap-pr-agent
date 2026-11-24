#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const { values } = parseArgs({ options: {
    config: { type: 'string', default: resolve(root, 'config/harness.json') },
    worktree: { type: 'string', default: resolve(root, '../whatap-open-mcp-agent') },
    'harness-worktree': { type: 'string' },
    'output-dir': { type: 'string' },
    'resume-mcp-after': { type: 'string' },
    'allow-git-submit': { type: 'boolean' },
    evidence: { type: 'string' },
    'goal-file': { type: 'string' },
  } });
  process.umask(0o077);
  if (values['harness-worktree']) {
    const target = await realpath(values['harness-worktree']);
    const runtime = await realpath(root);
    const contains = (a, b) => {
      const rel = relative(a, b);
      return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
    };
    if (contains(target, runtime) || contains(runtime, target))
      throw Error('실행 Harness와 수정 대상 Harness worktree를 분리하세요.');
  }
  await new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', resolve(root, 'tsconfig.json')], {
      cwd: root, stdio: 'inherit', timeout: 60_000,
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? done() : reject(Error('실행 Harness 빌드 실패')));
  });
  const { runAssignment } = await import('../dist/assignment.js');
  const result = await runAssignment({
    configPath: resolve(values.config), worktree: resolve(values.worktree),
    harnessWorktree: values['harness-worktree'] && resolve(values['harness-worktree']),
    outputDir: values['output-dir'] && resolve(values['output-dir']),
    resumeMcpAfter: values['resume-mcp-after'],
    goalPath: values['goal-file'] === undefined ? undefined : resolve(values['goal-file']),
    allowGitSubmit: values['allow-git-submit'] === true, evidencePath: values.evidence && resolve(values.evidence),
  });
  console.log(`과제 실행 결과 ${result.status}\n${result.directory}/assignment.md\n${result.directory}/assignment.json`);
  process.exitCode = result.status === 'VERIFIED' || result.status === 'NO_CHANGE' ? 0 : 1;
} catch (error) {
  console.error('과제 실행 초기화 실패', error.message);
  process.exitCode = 2;
}
