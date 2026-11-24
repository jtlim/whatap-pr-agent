import readline from 'node:readline';
import { basename } from 'node:path';
const filename = basename(process.argv[1] ?? '');
const mode = filename.includes('reference-mismatch') ? 'reference-mismatch'
 : filename.includes('time-error') ? 'candidate-time-error'
 : filename.includes('candidate-bad') ? 'candidate-bad'
 : filename.includes('candidate-truncated') ? 'candidate-truncated'
 : filename.includes('candidate-period-bad') ? 'candidate-period-bad'
 : filename.includes('candidate-missing') ? 'candidate-missing'
 : filename.includes('candidate-good') ? 'candidate-good' : 'reference';
const periodStart='2026-11-22 16:09:46 UTC', periodEnd='2026-11-22 16:14:46 UTC';
const stime=Date.parse('2026-11-22T16:09:46Z'),etime=Date.parse('2026-11-22T16:14:46Z');
const ts = Array.from({length:60},(_,i)=>Math.ceil(stime/5000)*5000+i*5000);
const tps=ts.map((time,i)=>({time,_id_:'5490_Java APM Demo',_name_:'Java APM Demo',tps:5.3981208354234695+(i%7)*0.15}));
const errors=ts.map((time,i)=>({time,_id_:'5490_Java APM Demo',_name_:'Java APM Demo',tx_error:i%10}));
const server=ts.flatMap((time,i)=>[1,2,3,4,5].map(j=>({time,_id_:j,_name_:`node${j}`,cpu:8.099998+(i%5)+(j%2),memory_pused:69.46861+j})));
function recordFor(name,args) {
 if(name.endsWith('server_metrics')) return [{_head_:{'cpu$':'P','memory_pused$':'P'}},...server];
 if(name.endsWith('apm_tps_series')) return [{_head_:{'tps$':'F'}},...tps];
 if(name.endsWith('apm_error_series')) return [{_head_:{'tx_error$':'F'}},...errors];
 return {data:[{count:3},{count:1}],total:2,retrievedTotal:2};
}
function tool(name){return{name,inputSchema:{type:'object',properties:{projectCode:{type:'number'},stime:{type:'number'},etime:{type:'number'}}}}}
const refNames=['whatap_http_server_metrics','whatap_http_apm_transactions','whatap_http_apm_errors','whatap_http_apm_tps_series','whatap_http_apm_error_series'];
const ref=mode==='reference'||mode==='reference-mismatch';
const tools=ref?[...refNames.map(tool),tool('huge')]:[
 {name:'whatap_query_data',inputSchema:{type:'object',properties:{projectCode:{type:'number'},path:{type:'string'},timeRange:{type:'string'},limit:{type:'number'}}}},
];
function result(data){return{content:[{type:'text',text:typeof data==='string'?data:JSON.stringify(data)}]}}
const ftime=ms=>new Date(ms).toISOString().replace('T',' ').slice(0,19)+' UTC';
const val=(v,c)=> c==='time'?ftime(v):typeof v==='number'&& !Number.isInteger(v)?v.toFixed(2):String(v??'-');
function formatted(path, rows){
 const filtered=mode==='candidate-missing'?rows.slice(1):rows;
 const bad=mode==='candidate-bad'&&path==='v2/app/tps_pcode';
 const header=path==='v2/sys/server_base'?
  ['time','_id_','_name_','cpu','memory_pused']:
  ['time','_id_','_name_',path==='v2/app/tps_pcode'?'tps':'tx_error'];
 const labels=header.map(c=>c==='cpu'||c==='memory_pused'?`${c} (%)`:c);
 let period=mode==='candidate-period-bad' ? '**Period**: invalid' : `**Period**: ${periodStart} → ${periodEnd}`;
 const table=['| '+labels.join(' | ')+' |', '| '+header.map(()=> '---').join(' | ')+' |'];
 for(const [i,row] of filtered.entries()) {
  table.push('| '+header.map(c=>bad && i===0&&c==='tps'?'999':val(row[c],c)).join(' | ')+' |');
 }
 const warning=mode==='candidate-truncated'?'> Result may be truncated (showing 60 rows).\n':'';
 return `## ${path}\n\n${period}\n\n${warning}${table.join('\n')}\n\n*Entity columns*: example\n---\n**Explore**: more paths`;
}
const cli=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of cli){
 if(!line.trim())continue;
 const req=JSON.parse(line);
 if(req.id===undefined)continue;
 let response;
 if(req.method==='initialize')response={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'mock',version:'1'}};
 else if(req.method==='tools/list')response={tools};
 else if(req.method==='tools/call'){
  const name=req.params.name,args=req.params.arguments??{};
  if(ref){
   if(name==='huge')response=result('x'.repeat(2_200_000));
   else {
    const fixed={
     whatap_http_server_metrics:['/open/api/flush/mxql/path','/v2/sys/server_base'],
     whatap_http_apm_transactions:['/open/api/v2/stat/transaction'],
     whatap_http_apm_errors:['/open/api/v2/stat/error'],
     whatap_http_apm_tps_series:['/open/api/flush/mxql/path','/v2/app/tps_pcode'],
     whatap_http_apm_error_series:['/open/api/flush/mxql/path','/v2/app/tx_error_pcode'],
    }[name];
    response=result({ok:true,status:200,contentType:'application/json',body:recordFor(name,args),request:{
     method:'POST',path:mode==='reference-mismatch'&&name==='whatap_http_server_metrics'?'/wrong-path':fixed[0],
     projectCode:args.projectCode,payload:{stime:args.stime,etime:args.etime,...(fixed[1]?{mql:fixed[1]}:{})},
    }});
   }
  } else if(mode==='candidate-time-error')response={isError:true,...result('Invalid time range format: absolute timestamps not supported')};
  else {
   let rows;
   if(args.path==='v2/sys/server_base')rows=server;
   else if(args.path==='v2/app/tps_pcode')rows=tps;
   else rows=errors;
   response=result(formatted(args.path,rows));
  }
 }else response={};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result:response})+'\n');
}
