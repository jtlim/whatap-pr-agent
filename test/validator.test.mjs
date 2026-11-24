import test from 'node:test';
import assert from 'node:assert/strict';
import { assessReference, compareRows, classifyMcpResult, verifyReferenceRequest, isWithinTimeWindow } from '../dist/validator.js';

const s = {
 id:'apm-tps-series', domain:'timeseries', projectCode:5490, stime:10000, etime:30000,
 referenceTool:'whatap_http_apm_tps_series', mcpPath:'v2/app/tps_pcode',
 expectedStepMs:5000, matchKeys:['time','_id_'], compareFields:['tps'], absoluteTolerance:0.000001,
};
const rows = [{time:10000,_id_:'demo',tps:1},{time:15000,_id_:'demo',tps:2},{time:20000,_id_:'demo',tps:3},{time:25000,_id_:'demo',tps:4}];

test('valid 5-second time-series coverage', () => {
 const r = assessReference(s,{ok:true,status:200,body:[{_head_:{'tps$':'F'}},...rows]});
 assert.equal(r.complete,true); assert.equal(r.rows.length,4);
 assert.ok(r.checks.find(c=>c.code==='TIMESERIES_COVERAGE').ok);
});
test('gaps in the time series are not silently accepted', () => {
 const r=assessReference(s,{ok:true,status:200,body:[{_head_:{'tps$':'F'}},...rows.slice(1)]});
 assert.equal(r.complete,false);
});
test('transaction stats total/retrievedTotal mismatch marks reference incomplete',()=>{
 const r=assessReference({...s,expectedStepMs:undefined}, {ok:true,status:200,body:{data:[{count:10}],total:2,retrievedTotal:1}});
 assert.equal(r.complete,false); assert.equal(r.total,2);
});
test('comparison handles accurate rows and small floating point differences',()=>{
 const clone=structuredClone(rows); clone[0].tps += 0.0000001;
 const r=compareRows(s,rows,clone);
 assert.equal(r.status,'PASS');
});
test('comparison detects mismatched metric field',()=>{
 const clone=structuredClone(rows); clone[2].tps=999;
 const r=compareRows(s,rows,clone);
 assert.equal(r.status,'FAIL'); assert.equal(r.reason,'FIELD_MISMATCH');
});
test('comparison detects missing record as FAIL',()=>{
 const r=compareRows(s,rows,rows.slice(1));
 assert.equal(r.status,'FAIL'); assert.equal(r.reason,'MISSING_OR_EXTRA_RECORDS');
});
test('comparison does not trust duplicated row IDs',()=>{
 const r=compareRows(s,rows,[...rows,rows[0]]);
 assert.equal(r.status,'UNVERIFIABLE'); assert.equal(r.reason,'AMBIGUOUS_RECORD_IDENTITIES');
});
test('error and Markdown outputs remain non-comparable',()=>{
 assert.equal(classifyMcpResult({isError:true,content:[{type:'text',text:'Invalid time range format'}]}).kind,'error');
 assert.equal(classifyMcpResult({content:[{type:'text',text:'| time | cpu |\n|--|--|\n|...|...|'}]}).kind,'formatted');
});

test('same arbitrary string from both API and MCP is PASS (API validity is out of scope)',()=>{
 const reference=structuredClone(rows), candidate=structuredClone(rows);
 reference[0].tps='abc'; candidate[0].tps='abc';
 const r=compareRows(s,reference,candidate);
 assert.equal(r.status,'PASS');
});
test('numeric and numeric-text transport representations are equivalent',()=>{
 const reference=structuredClone(rows), candidate=structuredClone(rows);
 reference[0].tps=25.5; candidate[0].tps='25.5';
 reference[1].tps='25.50'; candidate[1].tps=25.5;
 assert.equal(compareRows(s,reference,candidate).status,'PASS');
});
test('unequal arbitrary strings are FAIL',()=>{
 const reference=structuredClone(rows), candidate=structuredClone(rows);
 reference[0].tps='abc'; candidate[0].tps='def';
 assert.equal(compareRows(s,reference,candidate).status,'FAIL');
});
test('different metric field existence is FAIL',()=>{
 const candidate=structuredClone(rows);
 delete candidate[0].tps;
 assert.equal(compareRows(s,rows,candidate).status,'FAIL');
});
test('both missing configured comparison field do not cause false PASS',()=>{
 const reference=structuredClone(rows), candidate=structuredClone(rows);
 delete reference[0].tps; delete candidate[0].tps;
 assert.equal(compareRows(s,reference,candidate).status,'UNVERIFIABLE');
});
test('both sides same null metric passes equality without judging API quality',()=>{
 const reference=structuredClone(rows), candidate=structuredClone(rows);
 reference[0].tps=null; candidate[0].tps=null;
 assert.equal(compareRows(s,reference,candidate).status,'PASS');
});
test('row identity is still exact; metric-value normalization cannot collapse distinct IDs',()=>{
 const candidate=structuredClone(rows);
 candidate[0]._id_=1;
 assert.equal(compareRows(s,rows,candidate).status,'FAIL');
});
test('HTTP reference request metadata validates fixed project, path and window',()=>{
 const req={ok:true,status:200,request:{method:'POST',path:'/open/api/flush/mxql/path',
   projectCode:5490,payload:{stime:10000,etime:30000,mql:'/v2/app/tps_pcode'}}};
 assert.equal(verifyReferenceRequest(s,req).ok,true);
 assert.equal(verifyReferenceRequest(s,{...req,request:{...req.request,path:'/wrong'}}).ok,false);
 assert.equal(verifyReferenceRequest(s,{...req,request:{...req.request,payload:{...req.request.payload,limit:10}}}).ok,false);
 assert.equal(verifyReferenceRequest(s,{...req,request:{...req.request,projectCode:123}}).ok,false);
 assert.equal(verifyReferenceRequest(s,{...req,request:{...req.request,payload:{...req.request.payload,etime:30001}}}).ok,false);
 assert.equal(verifyReferenceRequest(s,{ok:true,status:200}).ok,false);
});

test('numeric vs string record identity is equivalent, but leading-zero identifier stays distinct',()=>{
 const candidate=structuredClone(rows);
 candidate[0].time=String(candidate[0].time);
 candidate[0]._id_='demo';
 assert.equal(compareRows(s,rows,candidate).status,'PASS');
 candidate[0].time='010000';
 assert.equal(compareRows(s,rows,candidate).status,'FAIL');
});


test('timeseries may include aligned end-boundary sample but never later timestamps',()=>{
 assert.equal(isWithinTimeWindow(s,30000),true);
 assert.equal(isWithinTimeWindow(s,35000),false);
 assert.equal(isWithinTimeWindow({...s,domain:'server'},30000),false);
 assert.equal(isWithinTimeWindow({...s,etime:30001},30001),false);
 assert.equal(isWithinTimeWindow(s,9999),false);
});

test('HTTP reference checks endpoint and recognizes full 5-second bucket-end coverage',()=>{
 const ended=[...rows.slice(1),{time:30000,_id_:'demo',tps:5}];
 const r=assessReference(s,{ok:true,status:200,body:ended});
 assert.equal(r.complete,true);
 assert.ok(r.checks.find(c=>c.code==='TIME_WINDOW').ok);
 assert.ok(r.checks.find(c=>c.code==='TIMESERIES_COVERAGE').ok);
 assert.equal(assessReference(s,{ok:true,status:200,body:[...ended,{time:35000,_id_:'demo',tps:6}]}).complete,false);
});
