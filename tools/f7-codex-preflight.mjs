/** F7.5 diagnostic-first real Codex preflight.
 * Keep read-only/workspace-write sandbox; never bypass OS security policies.
 * Trust tool events plus file evidence, not the assistant's final message alone.
 */
import {spawn,spawnSync} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';

const WITHOUT_MCP=['-c','mcp_servers.whatap.enabled=false','-c','mcp_servers.whatap-http.enabled=false'];
const CREDENTIAL_KEY=/^(WHATAP_|AWS_|GH_TOKEN$|GITHUB_TOKEN$|GIT_ASKPASS$|SSH_AUTH_SOCK$)/i;
function safeEnv(base){const env={...base};for(const k of Object.keys(env))if(CREDENTIAL_KEY.test(k))delete env[k];return env;}
function redactor(env,secret,writeToken){
 const values=[secret,writeToken,...Object.entries(env).filter(([k,v])=>/TOKEN|SECRET|PASSWORD|API_KEY/i.test(k)&&typeof v==='string'&&v.length>=8).map(([,v])=>v)];
 return input=>values.filter(Boolean).reduce((s,v)=>s.replaceAll(v,'[REDACTED]'),String(input)).replace(/sk-[A-Za-z0-9_-]{8,}/g,'[REDACTED]');
}
export function codexProbeArguments({mode,output,prompt}){
 if(!['read-only','workspace-write'].includes(mode))throw Error('Unsupported Codex probe mode');
 return ['exec','--ephemeral','--json','--sandbox',mode,'--skip-git-repo-check',
  ...(mode==='workspace-write'?['-c','sandbox_workspace_write.network_access=false']:[]),
  ...WITHOUT_MCP,'--output-last-message',output,prompt];
}
async function launch(bin,args,{cwd,env,timeoutMs}){
 return new Promise(done=>{
  let proc;try{proc=spawn(bin,args,{cwd,env,stdio:['ignore','pipe','pipe'],shell:false});}
  catch(e){done({code:null,signal:null,spawnError:String(e),timedOut:false,stdout:'',stderr:''});return;}
  let stderr='',stdout='',timedOut=false,overflow=false,settled=false;
  const MAX=400000;
  const append=(cur,b)=>{let x=cur+b.toString();if(x.length>MAX){overflow=true;x=x.slice(-MAX);}return x;};
  const timer=setTimeout(()=>{timedOut=true;proc.kill('SIGTERM');},timeoutMs);
  proc.stdout.on('data',b=>stdout=append(stdout,b));
  proc.stderr.on('data',b=>stderr=append(stderr,b));
  const finish=v=>{if(settled)return;settled=true;clearTimeout(timer);done({...v,timedOut,overflow,stdout,stderr});};
  proc.once('error',e=>finish({code:null,signal:null,spawnError:String(e)}));
  proc.once('close',(code,signal)=>finish({code,signal,spawnError:null}));
 });
}
export function summarizeJsonEvents(stdout,redact=s=>s,options={}){
 const events=String(stdout).split(/\r?\n/).filter(Boolean);let eventCount=0,commands=0,successfulCommands=0,failedCommands=0,fileChanges=0;
 let observedReadToken=false;
 const probeToken=options.probeToken;
 const errors=[];const types={};
 for(const line of events){
  let o;try{o=JSON.parse(line);}catch{continue;}
  eventCount++;types[o.type]=(types[o.type]??0)+1;
  if(o.type==='item.completed'&&o.item?.type==='command_execution'){
   commands++;if(o.item.exit_code===0)successfulCommands++;else failedCommands++;
   if(probeToken&&o.item.exit_code===0&&String(o.item.aggregated_output??'').includes(probeToken))observedReadToken=true;
   if(o.item.exit_code!==0)errors.push(redact(`command exit=${o.item.exit_code} ${o.item.aggregated_output??''}`).slice(-900));
  }
  if(o.type==='item.completed'&&o.item?.type==='file_change')fileChanges++;
  if(o.type==='error'||o.item?.type==='error')errors.push(redact(o.message??o.item?.message??'Unknown error').slice(-900));
  if(o.item?.type==='agent_message'&&/bwrap:|RTM_NEWADDR|Operation not permitted|sandbox failed/i.test(o.item.text??''))errors.push(redact(o.item.text).slice(-900));
 }
 return {eventCount,eventsByType:types,commands,successfulCommands,failedCommands,fileChanges,observedReadToken,errors:errors.slice(-5)};
}
export function classifyProbe({execution,events,readResultValid,toolEvidenceValid,redact=s=>s}){
 if(execution.code===0&&!execution.timedOut&&readResultValid&&toolEvidenceValid)return 'PASS';
 const diagnostics=[execution.stderr,...events.errors].join('\n');
 if(/bwrap:|RTM_NEWADDR|Failed to (?:create|enter).*namespace|landlock|Operation not permitted/i.test(diagnostics))return 'SANDBOX_DENIED';
 if(/401|403|unauthorized|not logged in|authentication|login required/i.test(diagnostics))return 'AUTH_BLOCKED';
 if(execution.spawnError)return 'CLI_START_FAILED';
 if(execution.timedOut)return 'CLI_TIMEOUT';
 if(execution.code!==0)return 'CLI_FAILED';
 if(!toolEvidenceValid)return 'NO_SUCCESSFUL_TOOL_EXECUTION';
 if(!readResultValid)return 'OUTPUT_MISMATCH';
 return 'PASS';
}
export async function runCodexPreflight({root,bin='codex',env=process.env,timeoutMs=120000}={}){
 if(!root)throw Error('Preflight requires an isolated root');
 const base=resolve(root),dir=join(base,'codex-preflight');
 await mkdir(dir,{recursive:false,mode:0o700});
 const safe=safeEnv(env);
 const version=spawnSync(bin,['--version'],{encoding:'utf8',env:safe,timeout:8000});
 const result={version:2,mode:'SYSTEM_BWRAP',codexVersion:String(version.stdout??'').trim().slice(0,100),
  status:'RUNNING',readOnly:'NOT_RUN',workspaceWrite:'NOT_RUN',at:new Date().toISOString(),attempts:[]};
 const output=join(base,'codex-preflight.json');
 const save=()=>writeFile(output,JSON.stringify(result,null,2)+'\n',{mode:0o600});
 await save();
 const secret=randomBytes(24).toString('hex'),writeToken=randomBytes(24).toString('hex');
 const redact=redactor(env,secret,writeToken);
 const perform=async({stage,mode,cwd,answer,prompt,actualExpected,probeToken})=>{
  const execution=await launch(bin,codexProbeArguments({mode,output:answer,prompt}),{cwd,env:safe,timeoutMs});
  const events=summarizeJsonEvents(execution.stdout,redact,{probeToken});
  const actual=(await readFile(answer,'utf8').catch(()=>'')).trim();
  const matches=actualExpected===undefined||actual===actualExpected||events.observedReadToken;
  const okTool=events.successfulCommands>0||events.fileChanges>0;
  const category=classifyProbe({execution,events,readResultValid:matches,toolEvidenceValid:okTool,redact});
  const record={stage,mode,category,exitCode:execution.code,signal:execution.signal,
   timedOut:execution.timedOut,overflow:execution.overflow,spawnError:execution.spawnError?redact(execution.spawnError):null,
   stderrTail:redact(execution.stderr).slice(-1400),events,
   answerPresent:actual.length>0,answerMatched:matches,toolEvidence:okTool};
  result.attempts.push(record);await save();
  if(category!=='PASS')throw Error(stage+' '+category+'; details in '+output);
 };
 try{
  const readonly=join(dir,'read-only');await mkdir(readonly,{mode:0o700});
  await writeFile(join(readonly,'read-token.txt'),secret+'\n',{mode:0o600});
  await perform({stage:'read',mode:'read-only',cwd:readonly,answer:join(dir,'read-answer.txt'),
   prompt:'실제 로컬 shell 명령으로 현재 디렉터리의 read-token.txt 파일을 읽고, 다른 설명 없이 그 파일의 문자열만 출력하세요. 파일 내용을 추측하지 마세요.',actualExpected:secret,probeToken:secret});
  if((await readFile(join(readonly,'read-token.txt'),'utf8')).trim()!==secret)throw Error('Read-only probe modified token file');
  result.readOnly='PASS';await save();
  const writable=join(dir,'workspace-write');await mkdir(writable,{mode:0o700});
  await writeFile(join(writable,'write-target.txt'),'BEFORE\n',{mode:0o600});
  await perform({stage:'write',mode:'workspace-write',cwd:writable,answer:join(dir,'write-answer.txt'),
   prompt:'현재 디렉터리의 write-target.txt 파일을 실제 로컬 shell 명령 또는 파일 수정 도구로 편집하여 전체 내용을 정확히 OK:'+writeToken+' 한 줄로 변경하세요. 다른 파일은 수정하지 마세요. 작업 후 완료라고만 답하세요.'});
  if((await readFile(join(writable,'write-target.txt'),'utf8')).trim()!=='OK:'+writeToken)
   throw Error('Workspace-write probe did not change isolated target file');
  result.workspaceWrite='PASS';result.status='PASS';await save();return result;
 }catch(e){
  // Informational, read-only host diagnostics. Never disable AppArmor, sandbox, or namespaces.
  const apparmorUserNs=(await readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns','utf8').catch(()=>null))?.trim()??null;
  const kernelUserNs=(await readFile('/proc/sys/kernel/unprivileged_userns_clone','utf8').catch(()=>null))?.trim()??null;
  const native=await launch(bin,['sandbox','--','/bin/pwd'],{cwd:dir,env:safe,timeoutMs:8000});
  result.hostDiagnostics={apparmorRestrictUnprivilegedUserns:apparmorUserNs,unprivilegedUsernsClone:kernelUserNs,
   legacySandboxDirectExitCode:native.code,legacySandboxDirectError:redact(native.stderr).slice(-650),
   legacySandboxDirectOutput:redact(native.stdout).slice(-200)};
  result.status='INFRA_BLOCKED';result.reason=redact(e?.message||String(e)).slice(0,1200);
  await save();const err=Error('CODEX_INFRA_BLOCKED: '+result.reason);err.code='CODEX_INFRA_BLOCKED';throw err;
 }
}
