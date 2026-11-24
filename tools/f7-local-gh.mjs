/** Local-only gh emulation for F7 E2E. No network, cannot touch real GitHub. */
import {readFile,writeFile,rename,realpath,stat} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {spawnSync} from 'node:child_process';

const stateFile=process.env.F7_LOCAL_GH_STATE;
const remote=process.env.F7_LOCAL_GIT_REMOTE;
const workspace=process.env.F7_LOCAL_AGENT_WORKTREE;
const fail=s=>{console.error('[F7 LOCAL GH BLOCKED] '+s);process.exit(3);};
if(!stateFile||!remote||!workspace||!/\/remote\.git$/.test(remote))fail('missing isolation environment');
const a=process.argv.slice(2);
if(a.some(x=>x==='--host'||x.startsWith('--repo=')))fail('explicit remote provider selection prohibited');
try{
 const cwd=await realpath(process.cwd());
 if(cwd!==await realpath(workspace))fail('caller is outside F7 isolated agent worktree');
 const p=spawnSync('git',['-C',cwd,'remote','get-url','origin'],{encoding:'utf8'});
 if(p.status!==0||resolve(p.stdout.trim())!==resolve(remote))fail('origin not the isolated local bare remote');
 const sha=()=>{const p=spawnSync('git',['-C',cwd,'rev-parse','HEAD'],{encoding:'utf8'});if(p.status!==0)fail('git HEAD unavailable');return p.stdout.trim();};
 const read=async()=>JSON.parse(await readFile(stateFile,'utf8').catch(()=>'{"prs":[],"comments":[]}'));
 const save=async data=>{const tmp=stateFile+'.tmp-'+process.pid;await writeFile(tmp,JSON.stringify(data,null,2)+'\n',{mode:0o600});await rename(tmp,stateFile);};
 const opt=(key)=>{const i=a.indexOf(key);if(i<0||!a[i+1])fail('missing '+key);return a[i+1];};
 const io=obj=>process.stdout.write(JSON.stringify(obj)+'\n');
 const user={login:'f7-local-bot'};
 const prObject=pr=>({...pr,headRefOid:pr.headRefOid,headRefName:'agent',baseRefName:'submission',state:'OPEN',mergedAt:null});
 if(a[0]==='repo'&&a[1]==='view'&&a.includes('.nameWithOwner'))process.stdout.write('f7-local/mock\n');
 else if(a[0]==='api'&&a[1]==='user'&&a.includes('.login'))process.stdout.write(user.login+'\n');
 else if(a[0]==='pr'&&a[1]==='list')io((await read()).prs.map(prObject));
 else if(a[0]==='pr'&&a[1]==='create'){
   if(opt('--base')!=='submission'||opt('--head')!=='agent')fail('invalid PR branch');
   const state=await read();if(state.prs.length)fail('test PR already exists');
   const pr={number:1,url:'https://example.invalid/f7-local/mock/pull/1',title:opt('--title'),body:opt('--body'),headRefOid:sha()};
   state.prs.push(pr);await save(state);process.stdout.write(pr.url+'\n');
 } else if(a[0]==='pr'&&a[1]==='view'){
   const state=await read();const pr=state.prs.find(x=>x.number===Number(a[2]));if(!pr)fail('unknown local PR');
   io(prObject(pr));
 } else if(a[0]==='api'&&a[1]?.startsWith('repos/f7-local/mock/issues/')){
   const q=/^repos\/f7-local\/mock\/issues\/(\d+)\/comments(?:\?per_page=100)?$/.exec(a[1]);
   if(!q||q[1]!=='1')fail('only local PR #1 comments are supported');
   const state=await read();
   if(a.includes('POST')){
     const bodyArgs=a.filter(x=>x.startsWith('body='));if(bodyArgs.length!==1)fail('invalid evidence comment');
     const entry={body:bodyArgs[0].slice(5),user};state.comments.push(entry);await save(state);io(entry);
   }else io(state.comments);
 }else fail('unrecognized local gh operation: '+a.slice(0,5).join(' '));
}catch(e){fail(String(e.message||e).slice(0,400));}
