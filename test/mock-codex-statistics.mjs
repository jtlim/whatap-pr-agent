#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
import {rows,markdown} from './mock-statistics-data.mjs';
const mode=process.argv[2]??'transaction';
const values=rows(mode).slice(0,4);
if(process.env.MOCK_STATS_CANDIDATE_BAD==='1')values[0][mode==='transaction'?'tx_count':'count']=9999;
const path=mode==='transaction'?'mxql/app/stat_tx_pcode':'mxql/app/stat_error_pcode';
const opts=process.env.MOCK_STATS_PROBE_ONLY==='1'?[{path:'mxql/apm/stat/error_stat',isError:true}]:
 process.env.MOCK_STATS_EXTRA_PROBE==='1'? [{path:'mxql/apm/stat/error_stat',isError:true},{path}]:
 process.env.MOCK_STATS_TWO_VALID==='1'?[{path},{path}]:
 process.env.MOCK_STATS_FIRST_ERROR==='1'?[{path,isError:true},{path}]:[{path}];
for(const [i,v] of opts.entries()){
 const args={projectCode:5490,path:v.path,timeRange:'1h',limit:1000};
 const shown=i>0&&process.env.MOCK_STATS_TWO_VALID==='1'?rows(mode).slice(0,6):values;
 if(i>0&&process.env.MOCK_STATS_SECOND_BAD==='1')shown[0][mode==='transaction'?'tx_count':'count']=9999;
 const result={content:[{type:'text',text:v.isError?'**Error**: yard template not executable':markdown(mode,shown)}],isError:!!v.isError};
 appendFileSync(process.env.WHATAP_HARNESS_TAP_FILE,JSON.stringify({request:{jsonrpc:'2.0',id:i+1,method:'tools/call',params:{name:'whatap_query_data',arguments:args}},response:{jsonrpc:'2.0',id:i+1,result}})+'\n');
 console.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'whatap',tool:'whatap_query_data',arguments:args,result:null}}));
}
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Mock stats response'}}));
console.log(JSON.stringify({type:'turn.completed'}));
