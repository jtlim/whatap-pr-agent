#!/usr/bin/env node
/** Realistic Codex proxy-tap fixture: 60 bucket-end rows, exactly aligned Period. */
import {appendFileSync} from 'node:fs';
const mode=process.argv[1]??'';
const stime=Date.parse('2026-11-22T18:26:00Z');
const etime=stime+300000;
const fmt=ms=>new Date(ms).toISOString().replace('T',' ').slice(0,19)+' UTC';
const vals=[];
for(let t=stime+5000;t<=etime;t+=5000){
 const val=Math.floor(t/5000)%5;
 vals.push({time:t,tx_error:mode.includes('bad-interior')&&t===stime+10000?99:
  mode.includes('bad-end')&&t===etime?99:val});
}
const col='| time | _id_ | _name_ | tx_error |\n| --- | --- | --- | --- |';
const body=vals.map(r=>`| ${fmt(r.time)} | 5490_Java APM Demo | Java APM Demo | ${r.tx_error} |`).join('\n');
const nums=vals.map(r=>r.tx_error);
const summary=`**Summary** (60 rows): **tx_error** (${Math.min(...nums)}–${Math.max(...nums)}, avg ${Number((nums.reduce((a,b)=>a+b,0)/nums.length).toFixed(1))})`;
const text=`## v2/app/tx_error_pcode\n\n**Period**: ${fmt(stime)} → ${fmt(etime)}\n\n${col}\n${body}\n\n${summary}`;
const args={projectCode:5490,path:'v2/app/tx_error_pcode',timeRange:'5m',limit:120};
const result={content:[{type:'text',text}]};
appendFileSync(process.env.WHATAP_HARNESS_TAP_FILE,JSON.stringify({
 request:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'whatap_query_data',arguments:args}},
 response:{jsonrpc:'2.0',id:1,result}})+'\n');
console.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'whatap',tool:'whatap_query_data',arguments:args,result:null}}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'APM 오류 시계열을 조회했습니다.'}}));
console.log(JSON.stringify({type:'turn.completed'}));
