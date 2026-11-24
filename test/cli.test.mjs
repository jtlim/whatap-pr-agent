import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('run preflight lists the failing checks, not a misleading doctor instruction', () => {
  const env = { ...process.env };
  delete env.WHATAP_API_TOKEN;
  delete env.WHATAP_HTTP_API_TOKEN;
  const run = spawnSync(process.execPath, ['dist/cli.js', 'run', '--scenario', 'apm-tps-series'], {
    cwd: resolve('.'), env, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /사전 환경 점검 실패/);
  assert.match(run.stderr, /MISSING WHATAP_API_TOKEN: missing/);
  assert.match(run.stderr, /MISSING WHATAP_HTTP_API_TOKEN: missing/);
  assert.doesNotMatch(run.stderr, /doctor 를 먼저 실행하세요/);
});
