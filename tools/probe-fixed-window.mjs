#!/usr/bin/env node
// Read-only MCP tools/list audit. Never executes tools/call or writes to a Git repository.
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { StdioMcpClient } from '../dist/mcp.js';
import { assessWindowSchema } from '../dist/fixed-window.js';

async function main() {
  const args=process.argv.slice(2);
  const valid=new Set(['--config','--entry','--timeout-ms']);
  const parsed=new Map();
  for(let i=0;i<args.length;i+=2){
    if(!valid.has(args[i])||i+1>=args.length||args[i+1].startsWith('--')||parsed.has(args[i]))
      throw Error(`Invalid option: ${args[i]??'(empty)'}`);
    parsed.set(args[i],args[i+1]);
  }
  const opt=name=>parsed.get(name)??null;
  const configPath=resolve(opt('--config')??'config/harness.json');
  let entry=opt('--entry');
  let timeoutMs=15000;
  if(opt('--timeout-ms')){
    timeoutMs=Number(opt('--timeout-ms'));
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>60000)throw Error('Invalid --timeout-ms');
  }
  if(!entry){
    const {loadConfig}=await import('../dist/config.js');
    const {config}=await loadConfig(configPath);
    entry=config.servers.candidate;
  }
  if(typeof entry!=='string'||!entry)throw Error('Missing MCP candidate entry');
  const client=new StdioMcpClient(resolve(entry),timeoutMs);
  try{
    await client.start();
    const tools=await client.listTools();
    const result=assessWindowSchema(tools);
    console.log(JSON.stringify({mode:'READ_ONLY_TOOL_SCHEMA',entry:resolve(entry),
      toolsListOnly:true,dataQueriesExecuted:0,assessment:result},null,2));
  }finally{await client.close();}
}
main().catch(e=>{
  // Do not print MCP stderr or server payloads: they can contain private context.
  const msg=String(e instanceof Error?e.message:e);
  console.error('MCP 도구 스키마 조회 실패:',msg.replaceAll(process.env.WHATAP_API_TOKEN || '\0','[REDACTED]')
    .replaceAll(process.env.WHATAP_HTTP_API_TOKEN || '\0','[REDACTED]').slice(0,400));
  process.exitCode=2;
});
