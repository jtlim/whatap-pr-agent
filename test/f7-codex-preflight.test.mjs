import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {codexProbeArguments,runCodexPreflight,classifyProbe,summarizeJsonEvents} from '../tools/f7-codex-preflight.mjs';

async function withFixture(fn){const root=await mkdtemp(join(tmpdir(),'f75-'));try{return await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
async function makeMock(root,mode='success'){
 const bin=join(root,'mock-codex');
 const source=`#!${process.execPath}\n`+`const fs=require('node:fs');const path=require('node:path');
const a=process.argv.slice(2),m=a[a.indexOf('--sandbox')+1],out=a[a.indexOf('--output-last-message')+1],prompt=a.at(-1);
if(a[0]==='--version'){console.log('codex mock 0.1');process.exit(0);}
if(!a.includes('--json')||a.some(x=>x.includes('features.use_legacy_landlock'))||a.includes('danger-full-access')||!a.includes('mcp_servers.whatap.enabled=false'))process.exit(4);
const ev=(x)=>console.log(JSON.stringify(x));
if('${mode}'==='sandbox'){
 ev({type:'item.completed',item:{type:'agent_message',text:'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted'}});
 fs.writeFileSync(out,'Unable to run commands.');process.exit(0);
}
if('${mode}'==='no-tool'){
 fs.writeFileSync(out,'I cannot access this file.');ev({type:'item.completed',item:{type:'agent_message',text:'Cannot read'}});process.exit(0);
}
if(m==='read-only'){
 let token=fs.readFileSync(path.join(process.cwd(),'read-token.txt'),'utf8');
 ev({type:'item.completed',item:{type:'command_execution',exit_code:0,aggregated_output:token,status:'completed'}});
 fs.writeFileSync(out,'${mode}'==='read-message-different'?'Read successfully':token);
}else if(m==='workspace-write'){
 let tok=prompt.match(/OK:([a-f0-9]{48})/);if(!tok)process.exit(5);
 fs.writeFileSync(path.join(process.cwd(),'write-target.txt'),'OK:'+tok[1]+'\\n');
 ev({type:'item.completed',item:{type:'command_execution',exit_code:0,aggregated_output:'',status:'completed'}});
 fs.writeFileSync(out,'Done!');
}else process.exit(6);
`;
 await writeFile(bin,source,{mode:0o700});await chmod(bin,0o700);return bin;
}
test('F7.5: read/write use JSONL evidence and legacy sandbox without full access',()=>{
 for(const mode of ['read-only','workspace-write']){
  const a=codexProbeArguments({mode,output:'/tmp/result',prompt:'probe'});
  assert.equal(a[a.indexOf('--sandbox')+1],mode);
  assert.ok(a.includes('--json'));
  assert.ok(!a.some(x=>x.includes('features.use_legacy_landlock')));
  assert.ok(!a.includes('danger-full-access'));
 }
});
test('F7.5: real file read and write confirmed by tool events and contents',()=>withFixture(async root=>{
 const bin=await makeMock(root);
 const result=await runCodexPreflight({root,bin,timeoutMs:8000,env:{...process.env,WHATAP_API_TOKEN:'secret-unused'}});
 assert.equal(result.status,'PASS');assert.equal(result.readOnly,'PASS');assert.equal(result.workspaceWrite,'PASS');
 assert.ok(result.attempts[0].events.observedReadToken);
 assert.equal(result.attempts[1].events.successfulCommands,1);
 assert.ok(!JSON.stringify(result).includes('secret-unused'));
}));
test('F7.5: final-message formatting cannot create false negative when command output proved read',()=>withFixture(async root=>{
 const bin=await makeMock(root,'read-message-different');
 const result=await runCodexPreflight({root,bin,timeoutMs:8000});
 assert.equal(result.status,'PASS');
 assert.equal(result.attempts[0].answerMatched,true);
}));
test('F7.5: model apology despite exit=0 is correctly diagnosed as sandbox denial',()=>withFixture(async root=>{
 const bin=await makeMock(root,'sandbox');
 await assert.rejects(runCodexPreflight({root,bin,timeoutMs:8000}),/CODEX_INFRA_BLOCKED: read SANDBOX_DENIED/);
 const d=JSON.parse(await readFile(join(root,'codex-preflight.json'),'utf8'));
 assert.equal(d.status,'INFRA_BLOCKED');assert.equal(d.attempts[0].exitCode,0);
 assert.equal(d.attempts[0].category,'SANDBOX_DENIED');
 assert.equal(d.workspaceWrite,'NOT_RUN');
}));
test('F7.5: no actual tool invocation is never accepted as PASS',()=>withFixture(async root=>{
 const bin=await makeMock(root,'no-tool');
 await assert.rejects(runCodexPreflight({root,bin,timeoutMs:8000}),/NO_SUCCESSFUL_TOOL_EXECUTION/);
 const d=JSON.parse(await readFile(join(root,'codex-preflight.json'),'utf8'));
 assert.equal(d.attempts[0].events.successfulCommands,0);
}));
test('F7.5: parse unsuccessful JSONL command tool events without inventing data',()=>{
 const x=summarizeJsonEvents(JSON.stringify({type:'item.completed',item:{type:'command_execution',exit_code:1,aggregated_output:'Permission denied'}}));
 assert.equal(x.failedCommands,1);assert.equal(x.successfulCommands,0);
 assert.equal(classifyProbe({execution:{code:0,stderr:''},events:x,readResultValid:false,toolEvidenceValid:false}),'NO_SUCCESSFUL_TOOL_EXECUTION');
});
test('F7.5: production Codex C1/C2 preserve legacy Landlock sandbox configuration',async()=>{
 for(const f of ['src/phasec.ts','src/phasec2.ts']){
  const source=await readFile(new URL('../'+f,import.meta.url),'utf8');
  assert.doesNotMatch(source,/features\.use_legacy_landlock/);
  assert.doesNotMatch(source,/danger-full-access/);
 }
});
