/** F7: isolated, local-only clone/remote/worktree and deterministic TPS output fault. */
import {spawnSync} from 'node:child_process';
import {readFile,writeFile,appendFile,mkdir,stat,realpath,symlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';

export const sha256=x=>createHash('sha256').update(x).digest('hex');
export function git(cwd,...args){
 const p=spawnSync('git',['-C',cwd,...args],{encoding:'utf8',maxBuffer:2*1024*1024,timeout:40000,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
 if(p.status!==0)throw Error(`git ${args[0]} failed: ${(p.stderr||p.stdout||'').slice(0,500)}`);
 return p.stdout.trim();
}
export function injectTpsError(source){
 // Require exactly one, source-specific anchor. Do not inject into generated dist or tests.
 const anchor='function formatValue(v: unknown, field?: string): string {';
 if(source.split(anchor).length!==2)throw Error('Unsupported source layout: formatValue not uniquely identified');
 const [before,tail]=source.split(anchor);
 const marker='    return Number.isInteger(v) ? String(v) : v.toFixed(2);';
 if(tail.split(marker).length!==2)throw Error('Unsupported source layout: metric formatting branch changed');
 const bad='    if (field === "tps") return String(Number((v + 1).toFixed(2)));\n';
 if(source.includes(bad))throw Error('Target already contains F7 fault');
 return before+anchor+tail.replace(marker,bad+marker);
}
/** Build-only dependencies stay in the main isolated clone; the agent worktree
 *  receives an ignored symlink. Git's `name/` ignore form only ignores real
 *  directories, not symlinks (Git mode 120000), so `/node_modules` is required.
 */
export async function linkIsolatedDependencies({main,agent}){
 const dependencies=join(main,'node_modules');
 if(!(await stat(dependencies).catch(()=>null))?.isDirectory())throw Error('Isolated main node_modules must exist before linking');
 await appendFile(join(main,'.git/info/exclude'),'\n# F7 build-only dependencies (shared by isolated worktrees)\n/node_modules\n/dist/\n');
 await symlink(dependencies,join(agent,'node_modules'),'dir');
 // Treat an ignored symlink as a prerequisite, not merely a clean-looking status.
 const check=spawnSync('git',['-C',agent,'check-ignore','-q','node_modules'],{encoding:'utf8'});
 if(check.status!==0)throw Error('Isolated dependency symlink is not ignored by Git');
 const dirty=git(agent,'status','--porcelain');
 if(dirty)throw Error('Isolated dependency link is unexpectedly seen as a Git source change: '+dirty.split('\n').slice(0,5).join(', '));
}
/** F7.2: Some MCP repos track generated dist bundles. Building an injected
 * fixture legitimately changes those tracked bundles, but it must never grant
 * a general dirty-worktree exception. Only tracked dist/* modifications are
 * promoted into the ISOLATED fixture baseline, then both local branches and
 * the LOCAL bare remote are fast-forwarded to the same commit.
 * Unexpected paths remain blocked and are printed for diagnosis.
 */
export function finalizeIsolatedBuildBaseline(stage){
 assertLocalRemote(stage.agent,stage.remote);
 assertLocalRemote(stage.main,stage.remote);
 const before=git(stage.agent,'status','--porcelain=v1','--untracked-files=all');
 if(!before)return {advanced:false,baselineSha:stage.injectedCommit,files:[]};
 const split=x=>x?x.split('\n').filter(Boolean):[];
 const changed=split(git(stage.agent,'diff','--name-only','HEAD'));
 const staged=split(git(stage.agent,'diff','--cached','--name-only'));
 const untracked=split(git(stage.agent,'ls-files','--others','--exclude-standard'));
 const valid=changed.length>0 && !staged.length && !untracked.length &&
   changed.every(f=>/^dist\/[^\r\n]+$/.test(f));
 if(!valid)throw Error('F7 build left unexpected Git changes (no bypass): '+before.split('\n').slice(0,12).join(' | '));
 // Commit only previously tracked, generated dist assets. git add -u never
 // stages ignored or newly created files, nor any unrelated source edits.
 git(stage.agent,'add','-u','--','dist');
 const stagedNow=split(git(stage.agent,'diff','--cached','--name-only'));
 if(stagedNow.length!==changed.length||stagedNow.some(x=>!changed.includes(x)))
   throw Error('F7 compiled baseline staged unexpected files: '+stagedNow.join(', '));
 git(stage.agent,'commit','-m','test(f7): include isolated injected candidate build artifacts');
 const sha=git(stage.agent,'rev-parse','HEAD');
 if(git(stage.agent,'status','--porcelain'))throw Error('F7 candidate still dirty after isolated build-baseline commit');
 // This FF updates only sandbox refs. Production Git and GitHub are untouched.
 git(stage.main,'merge','--ff-only',sha);
 if(git(stage.main,'status','--porcelain'))throw Error('F7 local submission worktree dirty after fast-forward');
 git(stage.main,'push','origin','agent:agent','submission:submission');
 if(git(stage.agent,'ls-remote','origin','refs/heads/agent').split(/\s+/)[0]!==sha ||
    git(stage.agent,'ls-remote','origin','refs/heads/submission').split(/\s+/)[0]!==sha)
   throw Error('F7 local bare remote refs did not both advance to the candidate build baseline');
 if(git(stage.agent,'rev-parse','refs/heads/submission')!==sha)
   throw Error('F7 local branches not aligned after isolated build-baseline commit');
 stage.injectedCommit=sha;
 return {advanced:true,baselineSha:sha,files:changed};
}
export function assertLocalRemote(repo,remote){
 const got=git(repo,'remote','get-url','origin');
 if(resolve(got)!==resolve(remote))throw Error('SECURITY: origin does not point to the F7 local bare remote');
 const st=spawnSync('git',['-C',repo,'remote','-v'],{encoding:'utf8'});
 if(st.status!==0||/https?:|git@|ssh:/i.test(st.stdout))throw Error('SECURITY: network Git remote detected in isolated repository');
}
export async function setupIsolation({sourceRepo,dest,identity='F7 Isolated Test'}){
 const src=await realpath(resolve(sourceRepo)),root=resolve(dest);
 if(root===src||root.startsWith(src+'/')||src.startsWith(root+'/'))throw Error('Sandbox must be disjoint from production source');
 if((await stat(root).catch(()=>null)))throw Error('Sandbox directory already exists; no re-use or reset');
 const parent=resolve(root,'..');await mkdir(parent,{recursive:true,mode:0o700});
 // Source is read only. Clone from the explicit existing submission branch.
 const p=spawnSync('git',['clone','--no-hardlinks','--branch','submission','--single-branch',src,join(root,'main')],{encoding:'utf8',timeout:120000});
 if(p.status!==0)throw Error('Cannot clone local submission branch: '+p.stderr.slice(0,400));
 const main=join(root,'main'),remote=join(root,'remote.git'),agent=join(root,'agent');
 const sourceCommit=git(main,'rev-parse','HEAD');
 const bare=spawnSync('git',['init','--bare',remote],{encoding:'utf8'});
 if(bare.status!==0)throw Error('Cannot create isolated bare repository: '+bare.stderr);
 git(main,'remote','set-url','origin',remote);assertLocalRemote(main,remote);
 git(main,'config','user.name',identity);git(main,'config','user.email','f7-isolated@example.invalid');
 const filename=join(main,'src/utils/format.ts');const old=await readFile(filename,'utf8');
 const changed=injectTpsError(old);await writeFile(filename,changed);
 git(main,'add','--','src/utils/format.ts');
 git(main,'commit','-m','test(f7): isolated reproducible tps display fault');
 const injectedCommit=git(main,'rev-parse','HEAD');
 git(main,'push','origin','submission:submission');
 git(main,'branch','agent','submission');git(main,'push','origin','agent:agent');
 git(main,'worktree','add',agent,'agent');
 assertLocalRemote(agent,remote);
 if(git(agent,'rev-parse','HEAD')!==git(agent,'rev-parse','refs/heads/submission'))throw Error('E2E source branch baseline mismatch');
 if(git(agent,'status','--porcelain'))throw Error('E2E agent source not clean');
 return {sourceCommit,injectedCommit,sourcePath:src,root,main,remote,agent,sourcePathChanged:'src/utils/format.ts',
   faultSourceSha256:sha256(changed),originalSourceSha256:sha256(old)};
}
