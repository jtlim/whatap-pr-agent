#!/usr/bin/env node
import readline from 'node:readline';
const omitEndBucket = process.argv[1].includes('omit-endpoint');
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
function rows(stime,etime){
 const aligned = stime%5000===0 && etime%5000===0;
 const start=aligned?stime+5000:Math.ceil(stime/5000)*5000;
 const result=[];
 for(let t=start;t<(aligned&&!omitEndBucket?etime+1:etime);t+=5000){
  result.push({time:t,_id_:'5490_Java APM Demo',_name_:'Java APM Demo',
   tps:5.12345+(Math.floor(t/5000)%7)*0.13});
 }
 return result;
}
for await(const line of lines){
 if(!line.trim())continue;
 const req=JSON.parse(line);
 if(req.id===undefined)continue;
 let result={};
 if(req.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'mock-reference-multi',version:'1'}};
 if(req.method==='tools/list')result={tools:[{name:'whatap_http_apm_tps_series',inputSchema:{type:'object',properties:{projectCode:{},stime:{},etime:{}}}}]};
 if(req.method==='tools/call'){
  const a=req.params?.arguments??{};
  const body=[{_head_:{'tps$':'F'}},...rows(a.stime,a.etime)];
  const data={ok:true,status:200,contentType:'application/json',body,request:{
   method:'POST',path:'/open/api/flush/mxql/path',projectCode:a.projectCode,
   payload:{stime:a.stime,etime:a.etime,mql:'/v2/app/tps_pcode'}}};
  result={content:[{type:'text',text:JSON.stringify(data)}]};
 }
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\n');
}
