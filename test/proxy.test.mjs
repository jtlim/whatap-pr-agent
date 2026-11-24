import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { once } from 'node:events';

test('transparent MCP proxy preserves bytes while recording full request and result',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mcp-tap-test-'));
  const tap=join(dir,'tap.jsonl');
  const proxy=resolve('tools/whatap-proxy.mjs'),child=resolve('test/mock-candidate-good.mjs');
  const cp=spawn(process.execPath,[proxy,child],{env:{...process.env,WHATAP_HARNESS_TAP_FILE:tap},stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';
  cp.stdout.on('data',chunk=>{stdout+=chunk.toString('utf8');});
  cp.stderr.on('data',chunk=>{stderr+=chunk.toString('utf8');});
  try{
    const req={jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'whatap_query_data',
      arguments:{projectCode:5490,path:'v2/app/tps_pcode',timeRange:'5m'}}};
    cp.stdin.write(JSON.stringify(req)+'\n');
    const start=Date.now();
    while(!stdout.includes('"id":5') && Date.now()-start<10000)await new Promise(r=>setTimeout(r,10));
    assert.ok(stdout.includes('"id":5'),stderr);
    const original=JSON.parse(stdout.split('\n').find(l=>l.includes('"id":5')));
    const tapped=JSON.parse((await readFile(tap,'utf8')).trim());
    assert.deepEqual(tapped.request,req);
    assert.deepEqual(tapped.response,original);
    assert.ok(tapped.response.result.content[0].text.includes('**Period**'));
  }finally{cp.kill('SIGTERM');await rm(dir,{recursive:true,force:true});}
});
