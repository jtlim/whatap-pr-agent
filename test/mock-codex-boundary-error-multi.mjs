#!/usr/bin/env node
/** First aligned bucket-end query then a normal retry with a shifted Period. */
import {appendFileSync} from 'node:fs';
const starts=[Date.parse('2026-11-22T18:26:00Z'),Date.parse('2026-11-22T18:26:04Z')];
const fmt=ms=>new Date(ms).toISOString().replace('T',' ').slice(0,19)+' UTC';
for(let i=0;i<2;i++){
 const stime=starts[i],etime=stime+300000;
 const vals=[];
 for(let t=Math.ceil((stime+1)/5000)*5000;t<=etime;t+=5000)vals.push({time:t,tx_error:Math.floor(t/5000)%5});
 const col='| time | _id_ | _name_ | tx_error |\n| --- | --- | --- | --- |';
 const body=vals.map(r=>`| ${fmt(r.time)} | 5490_Java APM Demo | Java APM Demo | ${r.tx_error} |`).join('\n');
 const nums=vals.map(r=>r.tx_error);
 const summary=`**Summary** (${vals.length} rows): **tx_error** (${Math.min(...nums)}–${Math.max(...nums)}, avg ${Number((nums.reduce((a,b)=>a+b,0)/nums.length).toFixed(1))})`;
 const text=`## v2/app/tx_error_pcode\n\n**Period**: ${fmt(stime)} → ${fmt(etime)}\n\n${col}\n${body}\n\n${summary}`;
 const args={projectCode:5490,path:'v2/app/tx_error_pcode',timeRange:'5m',...(i?{limit:120}:{})};
 const result={content:[{type:'text',text}]};
 appendFileSync(process.env.WHATAP_HARNESS_TAP_FILE,JSON.stringify({
  request:{jsonrpc:'2.0',id:i+1,method:'tools/call',params:{name:'whatap_query_data',arguments:args}},
  response:{jsonrpc:'2.0',id:i+1,result}})+'\n');
 console.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'whatap',tool:'whatap_query_data',arguments:args,result:null}}));
}
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'시계열 전체 조회 완료'}}));
console.log(JSON.stringify({type:'turn.completed'}));
