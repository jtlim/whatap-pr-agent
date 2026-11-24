#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const { values } = parseArgs({ options: {
    config: { type: 'string', default: resolve(root, 'config/harness.json') },
    worktree: { type: 'string', default: resolve(root, '../whatap-open-mcp-agent') },
    'allow-git-submit': { type: 'boolean' },
    evidence: { type: 'string' },
    'goal-file': { type: 'string' },
  } });
  process.umask(0o077);
  execFileSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', resolve(root, 'tsconfig.json')], {
    cwd: root, stdio: 'inherit', timeout: 60_000,
  });
  const { runAssignment } = await import('../dist/assignment.js');
  const result = await runAssignment({
    configPath: resolve(values.config), worktree: resolve(values.worktree),
    goalPath: values['goal-file'] === undefined ? undefined : resolve(values['goal-file']),
    allowGitSubmit: values['allow-git-submit'] === true, evidencePath: values.evidence && resolve(values.evidence),
  });
  console.log(`과제 실행 결과 ${result.status}\n${result.directory}/assignment.md\n${result.directory}/assignment.json`);
  process.exitCode = result.status === 'VERIFIED' || result.status === 'NO_CHANGE' ? 0 : 1;
} catch (error) {
  console.error('과제 실행 초기화 실패', error.message);
  process.exitCode = 2;
}
