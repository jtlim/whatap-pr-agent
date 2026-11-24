#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StdioMcpClient } from '../dist/mcp.js';
const prompt=process.argv.at(-1);
const isServer=/CPU|메모리/.test(prompt);
const isTps=/TPS/.test(prompt);
const isErrorSeries=/오류 시계열/.test(prompt);
if(isServer||isTps||isErrorSeries){
 const path=isServer?'v2/sys/server_base':isTps?'v2/app/tps_pcode':'v2/app/tx_error_pcode';
 const projectCode=isServer?33194:5490;
 // Natural-language fixture for a 5m window; deliberately does not add a limit.
 const args={projectCode,path,timeRange:'5m'};
 const client=new StdioMcpClient(resolve('test/mock-candidate-good.mjs'),15000);
 await client.start();
 try {
   const result=await client.callTool('whatap_query_data',args);
   const tap={request:{jsonrpc:'2.0',method:'tools/call',id:2,params:{name:'whatap_query_data',arguments:args}},
    response:{jsonrpc:'2.0',id:2,result}};
   appendFileSync(process.env.WHATAP_HARNESS_TAP_FILE,JSON.stringify(tap)+'\n');
   // Codex JSONL deliberately omits the complete tool result: Harness must use the TAP.
   console.log(JSON.stringify({type:'item.completed',item:{id:'item0',type:'mcp_tool_call',server:'whatap',tool:'whatap_query_data',arguments:args,result:null}}));
 }finally{await client.close();}
}
console.log(JSON.stringify({type:'item.completed',item:{id:'item1',type:'agent_message',text:'모의 사용자 응답'}}));
console.log(JSON.stringify({type:'turn.completed'}));
