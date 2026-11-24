#!/usr/bin/env node
/**
 * Phase F0 read-only startup diagnostic for installed candidate MCP.
 * Uses initialize + tools/list only. Never sends tools/call, modifies source, or runs Git.
 * Server initialization itself may perform internal side effects outside this tool's control.
 */
import { access, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { StdioMcpClient } from '../dist/mcp.js';
import { assessWindowSchema } from '../dist/fixed-window.js';
import { loadConfig } from '../dist/config.js';

const exists = async path => { try { await access(path); return true; } catch { return false; } };
const sensitiveEnvKeys = /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE|API_KEY|AUTH_KEY)/i;
function scrub(text) {
  let s=String(text ?? '');
  for (const [k,v] of Object.entries(process.env)) {
    if (sensitiveEnvKeys.test(k) && typeof v==='string' && v.length>=4) s=s.split(v).join('[REDACTED_ENV]');
  }
  return s
    .replace(/\bBearer\s+[^\s"']+/gi,'Bearer [REDACTED]')
    .replace(/((?:api[_-]?token|api[_-]?key|access[_-]?token|password|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi,'$1[REDACTED]')
    .replace(/https?:\/\/[^\s"']+/gi,'[REDACTED_URL]')
    .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b/g,'[REDACTED_TOKEN]');
}
function classify(s, message) {
  const combined=`${s}\n${message}`;
  if (/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find module|Cannot find package/i.test(combined)) return 'MODULE_NOT_FOUND';
  if (/SyntaxError|ERR_UNKNOWN_FILE_EXTENSION|Unexpected token/i.test(combined)) return 'JS_RUNTIME_OR_SYNTAX';
  if (/EACCES|EPERM|permission denied/i.test(combined)) return 'PERMISSION_ERROR';
  if (/ENOENT|no such file or directory/i.test(combined)) return 'FILE_NOT_FOUND';
  if (/WHATAP_API_TOKEN|missing.*token|token.*required|auth.*not (?:found|set|configured)/i.test(combined)) return 'POSSIBLE_AUTH_CONFIGURATION';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(combined)) return 'POSSIBLE_NETWORK_ERROR';
  if (/Malformed MCP JSON-RPC|stdout/i.test(combined)) return 'MCP_STDOUT_PROTOCOL_ERROR';
  if (/MCP .*timed out/i.test(combined)) return 'MCP_TIMEOUT';
  if (/terminated.*exit=/i.test(combined)) return 'MCP_EARLY_EXIT';
  return 'MCP_INITIALIZATION_ERROR';
}
function diagnosticLines(s) {
  const keys=/error|exception|missing|cannot find|not found|failed|invalid|undefined|module|token|syntax|permission|denied|node\.js|enoent|eacces|econnrefused/i;
  const unique=[];
  for (const raw of s.split(/\r?\n/)) {
    const line=raw.trim();
    if (!keys.test(line) || !line || unique.includes(line)) continue;
    unique.push(line.slice(0,350));
    if (unique.length>=6) break;
  }
  return unique;
}
function parseArgs(args) {
  const allowed=new Set(['--entry','--config','--timeout-ms']);
  const out={};
  for(let i=0;i<args.length;i+=2){
    if(!allowed.has(args[i]) || i+1>=args.length || args[i+1].startsWith('--') || out[args[i]])
      throw Error(`Invalid option: ${args[i] ?? '(missing)'}`);
    out[args[i]]=args[i+1];
  }
  const timeout=out['--timeout-ms'] ? Number(out['--timeout-ms']) : 15000;
  if(!Number.isSafeInteger(timeout)||timeout<1000||timeout>60000) throw Error('Invalid --timeout-ms');
  return {entry:out['--entry'],config:out['--config']??'config/harness.json',timeout};
}
async function main() {
  const opts=parseArgs(process.argv.slice(2));
  const configPath=resolve(opts.config);
  const entry=resolve(opts.entry ?? (await loadConfig(configPath)).config.servers.candidate);
  const projectRoot=resolve(dirname(entry),'..');
  const present=await exists(entry);
  const syntax=present ? spawnSync(process.execPath,['--check',entry],{encoding:'utf8',timeout:10000,env:process.env}) : null;
  const facts={mode:'READ_ONLY_MCP_STARTUP_DIAGNOSTIC',
    note:'Only initialize + tools/list. MCP server internal initialization may have side effects.',
    cwd:process.cwd(),entry, node:process.version,
    entryExists:present,
    nodeSyntaxCheck:syntax ? (syntax.status===0?'PASS':`FAILED exit=${syntax.status ?? 'unknown'}`) : 'NOT_RUN',
    packageJsonExists:await exists(resolve(projectRoot,'package.json')),
    nodeModulesExists:await exists(resolve(projectRoot,'node_modules')),
    envPresence:{WHATAP_API_TOKEN:Boolean(process.env.WHATAP_API_TOKEN),WHATAP_HTTP_API_TOKEN:Boolean(process.env.WHATAP_HTTP_API_TOKEN)},
    stage:'before_initialize',status:'NOT_STARTED'};
  if (!present) {
    facts.status='FAILED'; facts.category='FILE_NOT_FOUND';
    console.log(JSON.stringify(facts,null,2)); process.exitCode=1; return;
  }
  const client=new StdioMcpClient(entry,opts.timeout);
  try {
    facts.stage='initialize';
    await client.start();
    facts.stage='tools/list';
    const tools=await client.listTools();
    facts.status='SUCCESS'; facts.assessment=assessWindowSchema(tools);
    facts.dataQueriesExecuted=0;
  } catch(e) {
    const message=scrub(e instanceof Error?e.message:String(e));
    const stderr=scrub(client.stderrHint());
    facts.status='FAILED'; facts.category=classify(stderr,message);
    facts.failure=message.slice(0,450);
    facts.stderrIndicators=diagnosticLines(stderr);
    facts.stderrBytesSeen=client.stderrHint().length;
    facts.dataQueriesExecuted=0;
    process.exitCode=1;
  } finally { await client.close(); }
  console.log(JSON.stringify(facts,null,2));
  if(facts.status==='FAILED') console.error('주의: 로그를 공유하기 전 stderrIndicators에 민감정보가 없는지 확인해 주세요.');
}
main().catch(e => {
  console.error(JSON.stringify({mode:'READ_ONLY_MCP_STARTUP_DIAGNOSTIC',status:'ERROR',message:scrub(e instanceof Error?e.message:String(e)).slice(0,400)},null,2));
  process.exitCode=2;
});
