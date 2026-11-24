import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { repositories, submitAssignment } from '../dist/assignment-git.js';

for (const [target, repository] of Object.entries(repositories)) {
  test(`assignment submits only to ${repository} and handles its existing PR`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'assignment-git-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const repo = join(dir, 'repo');
    const tree = join(dir, 'agent');
    const bin = join(dir, 'bin');
    const gitPath = (await promisify(execFile)('which', ['git'])).stdout.trim();
    const git = async (cwd, ...args) => (await promisify(execFile)(gitPath, args, { cwd })).stdout.trim();
    await mkdir(repo);
    await mkdir(bin);
    await git(repo, 'init', '-b', 'submission');
    await git(repo, 'config', 'user.name', 'Test');
    await git(repo, 'config', 'user.email', 'test@example.test');
    const file = 'query.ts';
    await writeFile(join(repo, file), 'before\n');
    await git(repo, 'add', file);
    await git(repo, 'commit', '-m', 'base');
    await git(repo, 'worktree', 'add', '-b', 'agent', tree);
    const head = await git(repo, 'rev-parse', 'HEAD');
    const url = `https://github.com/${repository}.git`;
    const pr = `https://github.com/${repository}/pull/10`;
    const state = join(dir, 'state');
    const body = `#!${process.execPath}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const program = require('node:path').basename(process.argv[1]);
const args = process.argv.slice(2);
const path = ${JSON.stringify(state)};
const state = JSON.parse(fs.readFileSync(path));
if (program === 'git' && args.includes('ls-remote') && !args.includes('--get-url')) {
  if (!args.includes(${JSON.stringify(url)})) process.exit(10);
  fs.writeSync(1, ${JSON.stringify(head)} + String.fromCharCode(9) + 'refs/heads/submission' + String.fromCharCode(10));
  fs.writeSync(1, state.head + String.fromCharCode(9) + 'refs/heads/agent' + String.fromCharCode(10));
} else if (program === 'git' && args.includes('push')) {
  if (args.at(-2) !== ${JSON.stringify(url)} || !/^[a-f0-9]+:refs\\/heads\\/agent$/.test(args.at(-1))) process.exit(11);
  state.head = args.at(-1).split(':')[0];
} else if (program === 'gh') {
  if (args.at(-1) !== ${JSON.stringify('github.com/' + repository)} || !args.includes('agent') || !args.includes('submission')) process.exit(12);
  if (args.includes('create')) state.created++;
  if (args.includes('list')) fs.writeSync(1, JSON.stringify(state.created ? [{url: ${JSON.stringify(pr)}, headRefOid: state.head, isCrossRepository: false}] : []));
} else {
  const child = spawn(${JSON.stringify(gitPath)}, args, { stdio: 'inherit' });
  child.on('exit', code => process.exit(code ?? 99));
  return;
}
fs.writeFileSync(path, JSON.stringify(state));
`;
    await writeFile(join(bin, 'git'), body, { mode: 0o700 });
    await writeFile(join(bin, 'gh'), body, { mode: 0o700 });
    await writeFile(state, JSON.stringify({ head, created: target === 'harness' ? 1 : 0 }));
    const originalPath = process.env.PATH;
    process.env.PATH = bin + ':' + originalPath;
    t.after(() => { process.env.PATH = originalPath; });
    const wrong = target === 'harness' ? repositories.mcp : repositories.harness;
    await git(repo, 'remote', 'add', 'origin', `https://github.com/${wrong}.git`);
    const after = 'after\n';
    await writeFile(join(tree, file), after);
    const changes = [{ path: file, after }];
    await assert.rejects(submitAssignment(tree, head, changes, { status: '' }, async () => {}, target), /origin/);
    assert.equal(await git(tree, 'rev-parse', 'HEAD'), head);
    await git(repo, 'remote', 'set-url', 'origin', url);
    const receipt = { status: '' };
    await submitAssignment(tree, head, changes, receipt, async () => {}, target);
    assert.equal(receipt.pr, pr);
    assert.equal(receipt.commit, await git(tree, 'rev-parse', 'HEAD'));
    assert.equal(JSON.parse(await readFile(state, 'utf8')).created, 1);
  });
}
