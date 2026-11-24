import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { StdioMcpClient } from '../dist/mcp.js';
import { assessWindowSchema } from '../dist/fixed-window.js';

const tool=(props,required=[])=>[{name:'whatap_query_data',inputSchema:{type:'object',properties:props,required}}];
test('F0: missing or partial explicit window is not incorrectly approved',()=>{
 assert.equal(assessWindowSchema([]).verdict,'MISSING_TOOL');
 assert.equal(assessWindowSchema(tool({timeRange:{type:'string'}})).verdict,'NO_EXPLICIT_WINDOW');
 assert.equal(assessWindowSchema(tool({stime:{type:'integer'}})).verdict,'INCOMPLETE_WINDOW');
});
test('F0: ambiguous nonnumeric time values are never an eligible contract',()=>{
 const a=assessWindowSchema(tool({stime:{type:'string'},etime:{type:'integer'}}));
 assert.equal(a.verdict,'AMBIGUOUS_SCHEMA');
 assert.equal(a.absoluteFieldPair,null);
});
test('F0: required relative timeRange alongside absolute values is ambiguous',()=>{
 const a=assessWindowSchema(tool({timeRange:{type:'string'},stime:{type:'integer'},etime:{type:'integer'}},['timeRange']));
 assert.equal(a.verdict,'AMBIGUOUS_SCHEMA');
 assert.equal(a.requiresRelativeTimeRange,true);
});
test('F0: numeric stime/etime is ONLY a schema candidate, never proof of replay',()=>{
 const a=assessWindowSchema(tool({stime:{type:'integer'},etime:{type:'number'}}));
 assert.equal(a.verdict,'SCHEMA_CANDIDATE');
 assert.equal(a.absoluteFieldPair,'stime/etime');
 assert.match(a.limitations.join(' '),/실제로 준수/);
});
test('F0: duplicate tool names and uninspectable schemas fail closed',()=>{
 assert.equal(assessWindowSchema([...tool({}),...tool({})]).verdict,'AMBIGUOUS_SCHEMA');
 assert.equal(assessWindowSchema([{name:'whatap_query_data'}]).verdict,'AMBIGUOUS_SCHEMA');
});
test('F0: mock MCP stdio tools/list confirms relative-only contract without calling data',async()=>{
 const client=new StdioMcpClient(resolve('test/mock-window-relative.mjs'),10000);
 try { await client.start();const a=assessWindowSchema(await client.listTools());assert.equal(a.verdict,'NO_EXPLICIT_WINDOW'); }
 finally { await client.close(); }
});
test('F0: CLI tools/list audit with mock absolute schema prints only schema candidate',()=>{
 const p=spawnSync(process.execPath,['tools/probe-fixed-window.mjs','--entry','test/mock-window-absolute.mjs'],{encoding:'utf8',timeout:12000});
 assert.equal(p.status,0,p.stderr);
 const out=JSON.parse(p.stdout);
 assert.equal(out.mode,'READ_ONLY_TOOL_SCHEMA');
 assert.equal(out.dataQueriesExecuted,0);
 assert.equal(out.assessment.verdict,'SCHEMA_CANDIDATE');
 assert.equal(out.assessment.absoluteFieldPair,'stime/etime');
});
test('F0: CLI rejects unknown arguments before contacting MCP',()=>{
 const p=spawnSync(process.execPath,['tools/probe-fixed-window.mjs','--token','private'],{encoding:'utf8',timeout:12000});
 assert.equal(p.status,2);
 assert.match(p.stderr,/Invalid option/);
 assert.equal(p.stdout,'');
});
