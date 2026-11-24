#!/usr/bin/env node
/** MXQL mock implementing bucket-start [stime,etime) on aligned bounds. */
import readline from 'node:readline';
const mode=process.argv[1]??'';
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
function rows(stime,etime){
 const rounded=mode.includes('ignore-millis') ? Math.floor(stime/1000)*1000 : stime;
 const roundedEnd=mode.includes('ignore-millis') ? Math.floor(etime/1000)*1000 : etime;
 const start=Math.ceil(rounded/5000)*5000;
 const result=[];
 for(let t=start;t<roundedEnd;t+=5000){
  if(mode.includes('omit-end')&&t===Date.parse('2026-11-22T18:31:00Z'))continue;
  result.push({time:t,_id_:'5490_Java APM Demo',_name_:'Java APM Demo',
   tx_error:Math.floor(t/5000)%5 + (mode.includes('wrong-end')&&t===Date.parse('2026-11-22T18:31:00Z')?7:0)});
 }
 return result;
}
for await(const line of lines){
 if(!line.trim())continue;
 const req=JSON.parse(line);
 if(req.id===undefined)continue;
 let result={};
 if(req.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'mock-reference-boundary-error',version:'1'}};
 if(req.method==='tools/list')result={tools:[{name:'whatap_http_apm_error_series',inputSchema:{type:'object',properties:{projectCode:{},stime:{},etime:{}}}}]};
 if(req.method==='tools/call'){
  const a=req.params?.arguments??{};
  const payload={ok:true,status:200,body:[{_head_:{'tx_error$':'L'}},...rows(a.stime,a.etime)],request:{
   method:'POST',path:'/open/api/flush/mxql/path',projectCode:a.projectCode,
   payload:{stime:a.stime,etime:a.etime,mql:'/v2/app/tx_error_pcode'}}};
  result={content:[{type:'text',text:JSON.stringify(payload)}]};
 }
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\n');
}
