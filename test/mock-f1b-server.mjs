import readline from 'node:readline';
import { basename } from 'node:path';
const name=basename(process.argv[1]??'');
const reference=name.includes('reference');
const wrongPeriod=name.includes('wrong-period');
const badData=name.includes('bad-data');
const noSchema=name.includes('no-schema');
const sourceTime=Date.parse('2026-11-22T16:09:46Z');
const stopTime=Date.parse('2026-11-22T16:14:46Z');
const validPeriod=a=>
  (a.stime===sourceTime&&a.etime===stopTime)||(a.stime===sourceTime+1&&a.etime===stopTime+987);
const periodIso=ms=>new Date(ms).toISOString().replace('T',' ').replace('Z',' UTC');
const iso=ms=>new Date(ms).toISOString().replace('T',' ').slice(0,19)+' UTC';
const text=(body)=>({content:[{type:'text',text:typeof body==='string'?body:JSON.stringify(body)}]});
const schema={name:'whatap_query_data',inputSchema:{type:'object',properties:{projectCode:{type:'number'},path:{type:'string'},timeRange:{type:'string'},limit:{type:'number'},...(noSchema?{}:{stime:{type:'number'},etime:{type:'number'}})},required:['projectCode']}};
const httpSchema={name:'whatap_http_server_metrics',inputSchema:{type:'object',properties:{projectCode:{type:'number'},stime:{type:'number'},etime:{type:'number'}}}};
const rows=[{time:sourceTime+5000,_id_:'1',_name_:'srv1',cpu:8.1,memory_pused:60.2}];
const markdown=(s,e)=>`## v2/sys/server_base\n\n**Period**: ${periodIso(s)} → ${periodIso(e)}\n\n| time | _id_ | _name_ | cpu (%) | memory_pused (%) |\n| --- | --- | --- | --- | --- |\n| ${iso(sourceTime+5000)} | 1 | srv1 | ${badData?'99.99':'8.10'} | 60.20 |\n`;
for await(const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})) {
  if(!line.trim())continue;
  const req=JSON.parse(line);if(req.id===undefined)continue;
  let result;
  if(req.method==='initialize')result={protocolVersion:'2025-03-26',serverInfo:{name:'mock-f1b',version:'1'},capabilities:{tools:{}}};
  else if(req.method==='tools/list')result={tools:reference?[httpSchema]:[schema]};
  else if(req.method==='tools/call'){
    const {name:tool,arguments:a}=req.params;
    if(reference){
      if(tool!=='whatap_http_server_metrics'||!validPeriod(a))result={isError:true,...text('unexpected reference')};
      else result=text({ok:true,status:200,body:[{_head_:{'cpu$':'P','memory_pused$':'P'}},...rows],
        request:{method:'POST',path:'/open/api/flush/mxql/path',projectCode:a.projectCode,
          payload:{stime:a.stime,etime:a.etime,mql:'/v2/sys/server_base'}}});
    }else if(tool!=='whatap_query_data'||a.timeRange!==undefined||!validPeriod(a)){
      result={isError:true,...text('Fixed-window arguments were not honored')};
    }else result=text(markdown(a.stime+(wrongPeriod?1000:0),a.etime+(wrongPeriod?1000:0)));
  }else result={};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\n');
}
