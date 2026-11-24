import readline from 'node:readline';
import {readFileSync,writeFileSync} from 'node:fs';
import {basename} from 'node:path';
const reference=basename(process.argv[1]??'').includes('reference');
const badData=process.env.F2_MOCK_BAD==='1';
const noSchema=process.env.F2_MOCK_NO_SCHEMA==='1';
const noPeriod=process.env.F2_MOCK_NO_PERIOD==='1';
const origin=Date.parse('2026-11-22T16:09:46Z');
const iso=ms=>new Date(ms).toISOString().replace('T',' ').slice(0,19)+' UTC';
const text=value=>({content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value)}]});
const tools=[reference?{name:'whatap_http_server_metrics',inputSchema:{type:'object',properties:{projectCode:{type:'number'},stime:{type:'number'},etime:{type:'number'}}}}:
  {name:'whatap_query_data',inputSchema:{type:'object',properties:{projectCode:{type:'number'},path:{type:'string'},limit:{type:'number'},...(noSchema?{}:{timeRange:{type:'string'}})}}}];
const cell=(stime)=>({time:stime+5000,_id_:'1',_name_:'srv1',cpu:8.1,memory_pused:60.2});
for await(const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})){
 if(!line.trim())continue;
 const req=JSON.parse(line);if(req.id===undefined)continue;
 let result;
 if(req.method==='initialize')result={protocolVersion:'2025-03-26',serverInfo:{name:'mock-f2',version:'1'},capabilities:{tools:{}}};
 else if(req.method==='tools/list')result={tools};
 else if(req.method==='tools/call'){
   const {name,arguments:a}=req.params;
   if(reference){
      if(name!=='whatap_http_server_metrics')result={isError:true,...text('unexpected reference tool')};
      else result=text({ok:true,status:200,body:[{_head_:{'cpu$':'P','memory_pused$':'P'}},cell(a.stime)],
        request:{method:'POST',path:'/open/api/flush/mxql/path',projectCode:a.projectCode,
          payload:{stime:a.stime,etime:a.etime,mql:'/v2/sys/server_base'}}});
   }else if(name!=='whatap_query_data'||a.timeRange!=='5m'||a.path!=='v2/sys/server_base'||
      a.projectCode!==33194||a.limit!==150||Object.hasOwn(a,'stime')||Object.hasOwn(a,'etime'))
        result={isError:true,...text('Original relative arguments were not preserved')};
   else {
      const path=process.env.F2_MOCK_COUNTER_FILE;
      let n=0;
      if(path){try{n=Number(readFileSync(path,'utf8'))||0;}catch{}writeFileSync(path,String(n+1));}
      const stime=origin+10000*(n+1),etime=stime+300000;
      result=text(`## v2/sys/server_base\n\n${noPeriod?'':'**Period**: '+iso(stime)+' → '+iso(etime)}\n\n| time | _id_ | _name_ | cpu (%) | memory_pused (%) |\n| --- | --- | --- | --- | --- |\n| ${iso(stime+5000)} | 1 | srv1 | ${badData?'99.99':'8.10'} | 60.20 |\n`);
   }
 }else result={};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\n');
}
