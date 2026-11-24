#!/usr/bin/env node
// Simulated Codex event stream and transparent proxy tap. The reference server
// independently generates values from the Period supplied with each call.
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
const mode=basename(process.argv[1]);
const atEndpoint = mode.includes('endpoint');
const periods = atEndpoint
  ? [['2026-11-22T17:00:20Z','2026-11-22T18:00:20Z'],
     ['2026-11-22T17:00:20Z','2026-11-22T18:00:20Z']]
  : [['2026-11-22T16:00:01Z','2026-11-22T17:00:01Z'],
     ['2026-11-22T16:00:11Z','2026-11-22T17:00:11Z']];
const name='5490_Java APM Demo';
const ftime=ms=>new Date(ms).toISOString().replace('T',' ').slice(0,19)+' UTC';
for(let i=0;i<2;i++){
 const [start,end]=periods[i];
 const stime=Date.parse(start),etime=Date.parse(end);
 const args={projectCode:5490,path:'v2/app/tps_pcode',timeRange:'1h',...(i?{limit:721}:{})};
 const all=[];
 const first = atEndpoint ? stime + 5000 : Math.ceil(stime/5000)*5000;
 for(let t=first;t<(atEndpoint?etime+1:etime);t+=5000)all.push({time:t,
  tps:5.12345+(Math.floor(t/5000)%7)*0.13});
 const shown=all.slice(0,i?721:100);
 if(i===1 && mode.includes('endpoint-outside')) shown[shown.length-1].time=etime+5000;
 const header='| time | _id_ | _name_ | tps |\n| --- | --- | --- | --- |';
 const lines=shown.map((r,j)=>`| ${ftime(r.time)} | ${name} | Java APM Demo | ${
  ((i===0&&mode.includes('first-bad')&&j===0)||(i===1&&mode.includes('second-bad')&&j===0)||(i===1&&mode.includes('endpoint-bad-value')&&j===shown.length-1))?'999.00':r.tps.toFixed(2)} |`);
 const period=i===1&&mode.includes('unverifiable')?'**Period**: invalid':
  `**Period**: ${ftime(stime)} → ${ftime(etime)}`;
 const warning=i===0?'> Result may be truncated (showing 100 rows).\n':'';
 const text=`## v2/app/tps_pcode\n\n${period}\n\n${warning}${header}\n${lines.join('\n')}`;
 const result={content:[{type:'text',text}]};
 const tap={request:{jsonrpc:'2.0',id:i+1,method:'tools/call',params:{name:'whatap_query_data',arguments:args}},
  response:{jsonrpc:'2.0',id:i+1,result}};
 appendFileSync(process.env.WHATAP_HARNESS_TAP_FILE,JSON.stringify(tap)+'\n');
 // Real Codex may not expose result bodies; the tap is authoritative.
 console.log(JSON.stringify({type:'item.completed',item:{id:`t${i}`,type:'mcp_tool_call',server:'whatap',tool:'whatap_query_data',arguments:args,result:null}}));
}
console.log(JSON.stringify({type:'item.completed',item:{id:'end',type:'agent_message',text:'모의 전체 조회 완료'}}));
console.log(JSON.stringify({type:'turn.completed'}));
