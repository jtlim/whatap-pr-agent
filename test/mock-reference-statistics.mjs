#!/usr/bin/env node
import readline from 'node:readline';
import {rows,v2Stats,modeFromPath,first,start,end} from './mock-statistics-data.mjs';
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of lines){
 if(!line.trim())continue;
 const req=JSON.parse(line);if(req.id===undefined)continue;
 let result={};
 if(req.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'mock-stats-http',version:'1'}};
 if(req.method==='tools/list')result={tools:['whatap_http_mxql_path','whatap_http_apm_transactions','whatap_http_apm_errors'].map(name=>({name,inputSchema:{type:'object',properties:{}}}))};
 if(req.method==='tools/call'){
  const a=req.params?.arguments??{};
  const name=req.params.name;
  const mxql=name==='whatap_http_mxql_path';
  const mode=mxql?modeFromPath(a.path):name==='whatap_http_apm_errors'?'exception':'transaction';
  const all=rows(mode);
  if(process.env.MOCK_STATS_MISSING_BUCKET==='1'&&all.length)all.splice(-2,2);
  let body;
  if(mxql){
   body=[{_head_:{}},...all];
   if(process.env.MOCK_STATS_RAW_BAD==='1')body[1][mode==='transaction'?'tx_count':'count']=98;
  }else {
   const v2=v2Stats(mode,all);
   if(process.env.MOCK_STATS_V2_BAD==='1'&&v2.length)v2[0].count+=1;
   body={data:v2,total:v2.length,retrievedTotal:process.env.MOCK_STATS_V2_PARTIAL==='1'?v2.length+1:v2.length};
  }
  const path=mxql?'/open-mcp/api/flush/mxql/path':mode==='transaction'?'/open/api/v2/stat/transaction':'/open/api/v2/stat/error';
  const payload=mxql?{stime:a.stime,etime:a.etime,mql:'/'+a.path.replace(/^mxql\//,'')}: {stime:a.stime,etime:a.etime};
  const response={ok:true,status:200,body,request:{method:'POST',path,projectCode:a.projectCode,payload}};
  result={content:[{type:'text',text:JSON.stringify(response)}]};
 }
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\n');
}
