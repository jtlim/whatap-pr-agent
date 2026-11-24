import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,appendFile,symlink,lstat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {injectTpsError,setupIsolation,assertLocalRemote,linkIsolatedDependencies,finalizeIsolatedBuildBaseline,git} from '../tools/f7-isolation.mjs';
import {nextAction} from '../tools/auto-campaign.mjs';
const rootScript=resolve('tools/f7-local-gh.mjs');
const tmp=fn=>mkdtemp(join(tmpdir(),'f7-test-')).then(async root=>{try{return await fn(root);}finally{await rm(root,{recursive:true,force:true});}});
function run(bin,args,cwd,env){const p=spawnSync(bin,args,{cwd,encoding:'utf8',env:{...process.env,...env}});assert.equal(p.status,0,p.stderr+'\n'+p.stdout);return p.stdout.trim();}
async function fakeSource(root){
 const repo=join(root,'production');await mkdir(join(repo,'src/utils'),{recursive:true});
 run('git',['init','-b','submission',repo],root);
 git(repo,'config','user.name','fixture');git(repo,'config','user.email','fixture@example.invalid');
 await writeFile(join(repo,'src/utils/format.ts'),`function formatValue(v: unknown, field?: string): string {\n  if (typeof v === "number") {\n    return Number.isInteger(v) ? String(v) : v.toFixed(2);\n  }\n  return String(v);\n}\n`);
 git(repo,'add','-A');git(repo,'commit','-m','fixture');return repo;
}
test('F7: injected numeric tps defect affects only tps table values, with one audited source anchor',()=>{
 const text=`function formatValue(v: unknown, field?: string): string {\n  if (typeof v === "number") {\n    return Number.isInteger(v) ? String(v) : v.toFixed(2);\n  }\n  return String(v);\n}`;
 const bad=injectTpsError(text);
 assert.match(bad,/field === "tps"/);assert.match(bad,/v \+ 1/);
 assert.throws(()=>injectTpsError(bad),/already contains/);
 assert.throws(()=>injectTpsError('function different(){}'),/not uniquely/);
});
test('F7: clone creates isolated local Git agent/submission; original SHA and remote untouched',()=>tmp(async root=>{
 const src=await fakeSource(root),prior=git(src,'rev-parse','HEAD'),sb=await setupIsolation({sourceRepo:src,dest:join(root,'safe-test')});
 assertLocalRemote(sb.agent,sb.remote);
 assert.equal(git(src,'rev-parse','HEAD'),prior);
 assert.equal(git(sb.agent,'branch','--show-current'),'agent');
 assert.equal(git(sb.agent,'rev-parse','HEAD'),git(sb.agent,'rev-parse','refs/heads/submission'));
 assert.notEqual(sb.injectedCommit,prior);
 assert.match(await readFile(join(sb.agent,'src/utils/format.ts'),'utf8'),/field === "tps"/);
 assert.doesNotMatch(await readFile(join(src,'src/utils/format.ts'),'utf8'),/field === "tps"/);
 assert.equal(git(src,'status','--porcelain'),'');
 await assert.rejects(setupIsolation({sourceRepo:src,dest:join(root,'safe-test')}),/already exists/);
}));
test('F7: local PR emulator stores PR and evidence, without contacting gh or GitHub',()=>tmp(async root=>{
 const src=await fakeSource(root),sb=await setupIsolation({sourceRepo:src,dest:join(root,'run')});
 const env={F7_LOCAL_GH_STATE:join(root,'local-pr.json'),F7_LOCAL_GIT_REMOTE:sb.remote,F7_LOCAL_AGENT_WORKTREE:sb.agent};
 const gh=(...args)=>run(process.execPath,[rootScript,...args],sb.agent,env);
 assert.equal(gh('repo','view','--json','nameWithOwner','--jq','.nameWithOwner'),'f7-local/mock');
 assert.equal(gh('api','user','--jq','.login'),'f7-local-bot');
 assert.deepEqual(JSON.parse(gh('pr','list','--json','number,url,headRefOid,headRefName,baseRefName,body,state,mergedAt')),[]);
 gh('pr','create','--base','submission','--head','agent','--title','test','--body','full report');
 const pr=JSON.parse(gh('pr','view','1','--json','number,url,headRefOid,headRefName,baseRefName,body,state,mergedAt'));
 assert.equal(pr.body,'full report');assert.equal(pr.headRefName,'agent');assert.equal(pr.state,'OPEN');
 const sent=JSON.parse(gh('api','repos/f7-local/mock/issues/1/comments','--method','POST','-f','body=### rows\nA,B,C'));
 assert.equal(sent.body,'### rows\nA,B,C');
 assert.equal(JSON.parse(gh('api','repos/f7-local/mock/issues/1/comments?per_page=100')).length,1);
 assert.equal(git(src,'status','--porcelain'),'');
 const p=spawnSync(process.execPath,[rootScript,'pr','create','--base','submission','--head','agent','--title','x','--body','x'],{cwd:src,encoding:'utf8',env:{...process.env,...env}});
 assert.notEqual(p.status,0);assert.match(p.stderr,/caller is outside/);
}));
test('F7: auto campaign treats PR_OPEN as terminal submit (no automatic merge)',()=>{
 assert.deepEqual(nextAction({phase:'PR_OPEN',status:'PR_OPEN'}),{kind:'done'});
 assert.deepEqual(nextAction({phase:'CREATING_PR',status:'RUNNING'}),{kind:'stop',reason:'GIT_SIDE_EFFECT_RECONCILIATION_REQUIRED'});
});
test('F7: real Phase E submission adapter works against local-only gh and bare Git remote',()=>tmp(async root=>{
 const {realSubmissionHost}=await import('../dist/phasee.js');
 const {symlink,chmod}=await import('node:fs/promises');
 const src=await fakeSource(root),sb=await setupIsolation({sourceRepo:src,dest:join(root,'sandbox')});
 const bin=join(root,'bin');await mkdir(bin);
 const shell=join(bin,'gh');
 await writeFile(shell,`#!/bin/sh\nexec "${process.execPath}" "${rootScript}" "$@"\n`);await chmod(shell,0o700);
 const keys=['PATH','F7_LOCAL_GH_STATE','F7_LOCAL_GIT_REMOTE','F7_LOCAL_AGENT_WORKTREE'];
 const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{PATH:bin+':'+process.env.PATH,F7_LOCAL_GH_STATE:join(root,'pr.json'),
  F7_LOCAL_GIT_REMOTE:sb.remote,F7_LOCAL_AGENT_WORKTREE:sb.agent});
 try{
  const heads=await realSubmissionHost.remoteHeads(sb.agent);
  assert.equal(heads.agent,sb.injectedCommit);assert.equal(heads.submission,sb.injectedCommit);
  assert.deepEqual(await realSubmissionHost.listOpen(sb.agent),[]);
  const pr=await realSubmissionHost.createPr(sb.agent,'F7 evidence','한국어 보고서 + 원본 데이터');
  assert.equal(pr.number,1);assert.equal(pr.headOid,sb.injectedCommit);
  assert.equal((await realSubmissionHost.viewPr(sb.agent,1)).body,'한국어 보고서 + 원본 데이터');
  const parts=['전체 비교 1/2\nA,123,124,1','전체 비교 2/2\nB,5,5,0'];
  await realSubmissionHost.publishReportParts(sb.agent,1,'task-f7-synthetic',parts);
  assert.equal(await realSubmissionHost.reportPartsMatch(sb.agent,1,'task-f7-synthetic',parts),true);
  assert.equal(git(src,'status','--porcelain'),'');
 }finally{for(const [k,v] of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;}
}));

test('F7.1: directory-only gitignore does not hide node_modules symlink; shared Git exclude does',()=>tmp(async root=>{
 const src=await fakeSource(root),sb=await setupIsolation({sourceRepo:src,dest:join(root,'linked-deps')});
 await mkdir(join(sb.main,'node_modules'));await writeFile(join(sb.main,'node_modules','fixture.txt'),'test');
 await appendFile(join(sb.main,'.git/info/exclude'),'\nnode_modules/\n');
 // Git treats symlinks as link files, not as the directories they resolve to.
 await symlink(join(sb.main,'node_modules'),join(sb.agent,'node_modules'),'dir');
 assert.match(git(sb.agent,'status','--porcelain'),/\?\? node_modules/);
 await rm(join(sb.agent,'node_modules'));
 await linkIsolatedDependencies({main:sb.main,agent:sb.agent});
 assert.equal((await lstat(join(sb.agent,'node_modules'))).isSymbolicLink(),true);
 assert.equal(git(sb.agent,'status','--porcelain'),'');
 assert.equal(git(src,'status','--porcelain'),'');
}));


test('F7.2: tracked generated dist changes are committed only to isolated baseline and fast-forward both local refs',()=>tmp(async root=>{
 const src=await fakeSource(root),before=git(src,'rev-parse','HEAD');
 await mkdir(join(src,'dist'));await writeFile(join(src,'dist/index.js'),'export const tps = 0;\n');
 git(src,'add','dist/index.js');git(src,'commit','-m','fixture: track dist');
 const prodHead=git(src,'rev-parse','HEAD');
 const sb=await setupIsolation({sourceRepo:src,dest:join(root,'isolated')});
 assert.equal(git(sb.agent,'status','--porcelain'),'');
 await writeFile(join(sb.agent,'dist/index.js'),'export const tps = 1;\n');
 assert.match(git(sb.agent,'status','--porcelain'),/dist\/index\.js/);
 const prev=sb.injectedCommit;
 const result=finalizeIsolatedBuildBaseline(sb);
 assert.equal(result.advanced,true);
 assert.deepEqual(result.files,['dist/index.js']);
 assert.notEqual(sb.injectedCommit,prev);
 assert.equal(result.baselineSha,sb.injectedCommit);
 assert.equal(git(sb.agent,'status','--porcelain'),'');
 assert.equal(git(sb.main,'status','--porcelain'),'');
 assert.equal(git(sb.agent,'rev-parse','HEAD'),sb.injectedCommit);
 assert.equal(git(sb.main,'rev-parse','HEAD'),sb.injectedCommit);
 assert.equal(git(sb.agent,'ls-remote','origin','refs/heads/agent').split(/\s+/)[0],sb.injectedCommit);
 assert.equal(git(sb.agent,'ls-remote','origin','refs/heads/submission').split(/\s+/)[0],sb.injectedCommit);
 assert.equal(git(src,'rev-parse','HEAD'),prodHead);
 assert.equal(git(src,'status','--porcelain'),'');
 assert.notEqual(before,prodHead);
 const unchanged=finalizeIsolatedBuildBaseline(sb);
 assert.equal(unchanged.advanced,false);
}));

test('F7.2: any unexpected source or untracked build change stays BLOCKED with paths, never committed or pushed',()=>tmp(async root=>{
 const src=await fakeSource(root),sb=await setupIsolation({sourceRepo:src,dest:join(root,'sandbox')});
 const before=sb.injectedCommit;
 await writeFile(join(sb.agent,'src/utils/format.ts'),'unexpected source drift\n');
 await assert.rejects(async()=>finalizeIsolatedBuildBaseline(sb),/unexpected Git changes.*src\/utils\/format\.ts/);
 assert.equal(git(sb.agent,'rev-parse','HEAD'),before);
 assert.equal(git(sb.agent,'ls-remote','origin','refs/heads/agent').split(/\s+/)[0],before);
 assert.equal(git(sb.agent,'ls-remote','origin','refs/heads/submission').split(/\s+/)[0],before);
}));
