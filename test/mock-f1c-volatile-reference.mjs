// Synthetic HTTP MCP reference: per-request duration varies, metrics stay fixed.
// Optional test mode alters a non-comparison data column on the second read.
import readline from 'node:readline';
import {readFileSync,writeFileSync} from 'node:fs';
const start=Date.parse('2026-11-22T16:09:46Z');
let n=0;
const text=body=>({content:[{type:'text',text:JSON.stringify(body)}]});
for await(const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})){
  if(!line.trim())continue;
  const req=JSON.parse(line);if(req.id===undefined)continue;
  let result;
  if(req.method==='initialize')result={protocolVersion:'2025-03-26',serverInfo:{name:'mock-f1c-volatile-ref',version:'1'},capabilities:{tools:{}}};
  else if(req.method==='tools/list')result={tools:[{name:'whatap_http_server_metrics',inputSchema:{type:'object',properties:{projectCode:{type:'number'},stime:{type:'number'},etime:{type:'number'}}}}]};
  else if(req.method==='tools/call'){
    const a=req.params.arguments;
    n++;
    // The probe launches the reference MCP afresh each run. Persist mock-only
    // counter in the disposable test HOME so the two independent calls differ.
    let runNo=n;
    if(process.env.MOCK_F1C_STATE_FILE){
      try{runNo=Number(readFileSync(process.env.MOCK_F1C_STATE_FILE,'utf8'))+1;}catch{runNo=1;}
      writeFileSync(process.env.MOCK_F1C_STATE_FILE,String(runNo));
    }
    const name=process.env.MOCK_F1C_CHANGED_ROW==='1'&&runNo>1 ? 'srv2':'srv1';
    result=text({status:200,ok:true,durationMs:150+runNo,
      body:[{_head_:{'cpu$':'P','memory_pused$':'P'}},{time:start+5000,_id_:'1',_name_:name,cpu:8.1,memory_pused:60.2}],
      request:{method:'POST',path:'/open/api/flush/mxql/path',projectCode:a.projectCode,
        payload:{stime:a.stime,etime:a.etime,mql:'/v2/sys/server_base'}}});
  }else result={};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\n');
}
