import readline from 'node:readline';
import { basename } from 'node:path';
const name=basename(process.argv[1]??'');
const type=name.includes('absolute')?'absolute':name.includes('incomplete')?'incomplete':name.includes('ambiguous')?'ambiguous':'relative';
const props={projectCode:{type:'number'},path:{type:'string'},timeRange:{type:'string'},limit:{type:'number'}};
const required=['projectCode','path'];
if(type==='absolute'){
  props.stime={type:'integer'}; props.etime={type:'integer'};
}else if(type==='incomplete')props.stime={type:'integer'};
else if(type==='ambiguous'){
  props.stime={type:'integer'};props.etime={type:'number'};required.push('timeRange');
}
const tools=[{name:'whatap_query_data',inputSchema:{type:'object',properties:props,required}}];
for await (const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})) {
  if(!line.trim())continue;
  const request=JSON.parse(line);
  if(request.id===undefined)continue;
  if(!['initialize','tools/list'].includes(request.method)){
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Read only: tools/call forbidden'}})+'\n');
    continue;
  }
  const result=request.method==='initialize'?
    {protocolVersion:'2025-03-26',serverInfo:{name:'schema-mock',version:'1'},capabilities:{tools:{}}} :{tools};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
}
