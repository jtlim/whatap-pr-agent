import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repository = 'jtlim/whatap-open-mcp';
const url = `https://github.com/${repository}.git`;
type Receipt = { status: string; commit?: string; pr?: string };

export async function submitAssignment(worktree: string, head: string,
  changes: Array<{ path: string; after: string | null }>, receipt: Receipt,
  assertVerifiedSource: () => Promise<void>): Promise<void> {
  const run = async (program: string, args: string[]) => (await exec(program, args, {
    cwd: worktree, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com' },
  })).stdout;
  const git = (...args: string[]) => run('git', ['-c', 'core.hooksPath=/dev/null', ...args]);
  const gh = (...args: string[]) => run('gh', [...args, '--repo', `github.com/${repository}`]);
  // Explicit URL also avoids origin selection and push refspecs from the local checkout.
  if ((await git('ls-remote', '--get-url', url)).trim() !== url ||
      (await git('config', '--get-regexp', '^url\\..*\\.pushinsteadof$').catch((e: {code: number}) => {
        if (e.code === 1) return '';
        throw e;
      })).trim())
    throw Error('Git URL 재작성 설정으로 제출 목적지를 확인할 수 없습니다.');
  const refs = await git('ls-remote', '--heads', url, 'refs/heads/agent', 'refs/heads/submission');
  const branch = (name: string) => refs.match(new RegExp(`^([a-f0-9]{40,64})\\s+refs/heads/${name}$`, 'm'))?.[1];
  const base = branch('submission');
  if (branch('agent') !== head || !base) throw Error('fork의 agent 또는 submission 원격 브랜치 상태를 확인하세요.');
  await git('merge-base', '--is-ancestor', base, head);

  const listPrs = async () => JSON.parse(await gh('pr', 'list', '--head', 'agent', '--base', 'submission', '--state', 'open',
    '--json', 'url,headRefOid,isCrossRepository')) as Array<{ url: string; headRefOid: string; isCrossRepository: boolean }>;
  const open = await listPrs();
  if (open.length > 1 || open.some(pr => pr.isCrossRepository || pr.headRefOid !== head))
    throw Error('기존 PR의 head 또는 제출 대상을 확인할 수 없습니다.');
  if (open.length === 0 && (await git('diff', '--name-only', base, head)).trim())
    throw Error('새 PR에는 현재 실행에서 검증한 변경만 포함할 수 있습니다. 기존 agent와 submission 차이를 확인하세요.');

  await assertVerifiedSource();
  const paths = changes.map(change => change.path);
  await git('add', '-A', '--', ...paths);
  receipt.status = '스테이징 완료';
  const staged = (await git('diff', '--cached', '--name-only', '-z')).split('\0').filter(Boolean).sort();
  if (JSON.stringify(staged) !== JSON.stringify([...paths].sort())) throw Error('스테이징 범위와 검증한 파일이 다릅니다.');
  for (const change of changes) {
    if (change.after !== null && await git('show', `:${change.path}`) !== change.after)
      throw Error('스테이징된 파일 내용과 검증한 소스가 다릅니다.');
  }
  await git('commit', '-m', 'Fix independently verified WhaTap MCP behavior');
  const commit = (await git('rev-parse', 'HEAD')).trim();
  receipt.commit = commit;
  receipt.status = '로컬 커밋 완료';
  if ((await git('rev-parse', 'HEAD^')).trim() !== head ||
      (await git('diff', '--name-only', '-z', head, commit)).split('\0').filter(Boolean).sort().join('\0') !== staged.join('\0'))
    throw Error('커밋 내용이나 부모가 검증 대상과 다릅니다.');
  for (const change of changes) {
    if (change.after !== null && await git('show', `${commit}:${change.path}`) !== change.after)
      throw Error('커밋된 파일 내용과 검증한 소스가 다릅니다.');
  }
  await git('push', url, `${commit}:refs/heads/agent`);
  receipt.status = '원격 agent 업데이트 완료';
  if (!open.length) {
    await gh('pr', 'create', '--base', 'submission', '--head', 'agent',
      '--title', 'Fix independently verified WhaTap MCP behavior',
      '--body', 'The harness rebuilt the candidate, ran the existing tests, and verified MCP responses against an independent HTTP client. Detailed data and logs are retained locally.');
  }
  const prs = await listPrs();
  if (prs.length !== 1 || prs[0].isCrossRepository || prs[0].headRefOid !== commit ||
      !/^https:\/\/github\.com\/jtlim\/whatap-open-mcp\/pull\/\d+$/.test(prs[0].url))
    throw Error('원격 push 이후 대상 PR을 확인하지 못했습니다.');
  receipt.pr = prs[0].url;
  receipt.status = 'PR 확인 완료';
}
