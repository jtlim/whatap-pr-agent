import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMcpPeriod, parseFormattedMcp, forMcpDisplay, expectedDurationMs } from '../dist/period.js';
import { assessReference, compareRows } from '../dist/validator.js';
const txt=`## v2/app/tps_pcode\n\n**Period**: 2026-11-22 16:09:46 UTC → 2026-11-22 16:14:46 UTC\n\n| time | _id_ | tps |\n| --- | --- | --- |\n| 2026-11-22 16:09:50 UTC | demo | 5.40 |\n| 2026-11-22 16:09:55 UTC | demo | abc |\n\n### Summary\n\n| Metric | Avg |\n| --- | --- |\n| TPS | 5.40 |`;
test('Period parser preserves UTC and complete seconds, without inventing milliseconds',()=>{
 const p=parseMcpPeriod(txt);
 assert.equal(p.stime,1795363786000);
 assert.equal(p.etime,1795364086000);
 assert.equal(expectedDurationMs('5m'),p.etime-p.stime);
 assert.equal(expectedDurationMs('bad'),null);
});
test('Markdown parser ignores summary table and preserves arbitrary metric text',()=>{
 const p=parseFormattedMcp(txt,['time','_id_','tps']);
 assert.equal(p.ok,true);
 assert.equal(p.data.rows.length,2);
 assert.equal(p.data.rows[1].tps,'abc');
 assert.equal(p.data.rows[0].time,1795363790000);
});
test('Markdown parser does not accept an ambiguous duplicate data table',()=>{
 const p=parseFormattedMcp(txt+'\n\n'+txt,['time','_id_','tps']);
 assert.equal(p.ok,false);
 assert.equal(p.reason,'MCP_DATA_TABLE_MISSING_OR_AMBIGUOUS');
});
test('HTTP reference is normalized exactly like MCP float formatting, without making abc invalid',()=>{
 const s={matchKeys:['time','_id_'],compareFields:['tps'],absoluteTolerance:0};
 const a=[{time:1795363790000,_id_:'demo',tps:5.3981208354234695},{time:1795363795000,_id_:'demo',tps:'abc'}];
 const b=parseFormattedMcp(txt,['time','_id_','tps']).data.rows;
 const compared=compareRows(s,forMcpDisplay(a,['tps']),b);
 assert.equal(compared.status,'PASS');
});
test('timeseries completeness uses 5s-aligned timestamps, not unaligned Period seconds',()=>{
 const s={stime:1795363786000,etime:1795364086000,expectedStepMs:5000};
 const rows=Array.from({length:60},(_,i)=>({time:1795363790000+i*5000,_id_:'demo',tps:5}));
 const r=assessReference(s,{status:200,ok:true,body:rows});
 assert.equal(r.complete,true);
});
