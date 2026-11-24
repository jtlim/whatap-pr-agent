import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../tools/replay-run.mjs', import.meta.url));

// The existing replay CLI reads its scenario definitions relative to its cwd.
export function replaySavedRun(runDir) {
  const cwd = mkdtempSync(join(tmpdir(), 'harness-replay-'));
  try {
    mkdirSync(join(cwd, 'config'));
    copyFileSync(new URL('./harness.json', import.meta.url), join(cwd, 'config', 'harness.json'));
    return spawnSync(process.execPath, [script, runDir], { cwd, encoding: 'utf8' });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
