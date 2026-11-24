#!/usr/bin/env node
// Transparent stdio MCP bridge. No requests/results or input parameters are changed.
// Writes a redacted shadow copy of real JSON-RPC tools/call request-response pairs.
// Used by the Harness to avoid depending on Codex's potentially truncated event results.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
const childEntry=process.argv[2];
const tapFile=process.env.WHATAP_HARNESS_TAP_FILE;
if(!childEntry || !tapFile){process.stderr.write('Missing child MCP entry or tap output file\n');process.exit(2);}
const child=spawn(process.execPath,[childEntry],{stdio:['pipe','pipe','inherit'],env:process.env});
const waiting=new Map();
const scrub=s=>[process.env.WHATAP_API_TOKEN,process.env.WHATAP_HTTP_API_TOKEN]
  .filter(Boolean).reduce((x,v)=>x.replaceAll(v,'[REDACTED]'),s);
function observer(stream,accept){
  const decoder=new StringDecoder('utf8');let pending='';
  stream.on('data',buf=>{pending+=decoder.write(buf);let end;
    while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);
      try{accept(JSON.parse(line));}catch{ /* never block the real MCP transport */ }
    }
  });
}
// Passive observers must never consume or rewrite the actual transport.
observer(process.stdin,req=>{
 if(req.method==='tools/call' && req.id!==undefined)waiting.set(JSON.stringify(req.id),req);
});
observer(child.stdout,res=>{
 if(res.id===undefined)return;
 const k=JSON.stringify(res.id),req=waiting.get(k);
 if(!req)return;
 waiting.delete(k);
 try{appendFileSync(tapFile,scrub(JSON.stringify({request:req,response:res}))+'\n',{mode:0o600});}
 catch(e){process.stderr.write(`MCP tap write failed: ${String(e)}\n`);}
});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.on('exit',(code)=>{if(process.stdout.writable)process.stdout.end();process.exitCode=code??1;});
process.on('SIGTERM',()=>child.kill('SIGTERM'));
