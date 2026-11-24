export const start=Date.parse('2026-11-22T18:00:01Z');
export const end=Date.parse('2026-11-22T19:00:01Z');
export const first=Date.parse('2026-11-22T18:05:00Z');
const bucket=300_000;
export const ftime=ms=>new Date(ms).toISOString().replace('T',' ').slice(0,19)+' UTC';
export function rows(mode){
 const result=[];
 for(let i=0;i<11;i++)for(let j=0;j<2;j++){
  const time=first+i*bucket;
  if(mode==='transaction')result.push({time,pcode:5490,tx_hash:111+j,oid:123,okind:22,
    tx_count:2+j,tx_error:j,tx_time_sum:25.5+j*4,
    ...(j===0?{httpc_count:5}:{})});
  else result.push({time,pcode:5490,classHash:110+j,serviceHash:210+j,oid:123,
    msg:310+j,count:3+j});
 }
 return result;
}
export const keys=mode=>mode==='transaction'?
 ['time','pcode','tx_hash','oid','okind','tx_count','tx_error','tx_time_sum','httpc_count']:
 ['time','pcode','classHash','serviceHash','oid','msg','count'];
export const modeFromPath=path=>String(path).includes('stat_error')?'exception':'transaction';
export function v2Stats(mode,values){
 const m=new Map();
 for(const r of values){
  const k=mode==='transaction'?String(r.tx_hash):`${r.classHash}/${r.serviceHash}/${r.msg}`;
  if(!m.has(k))m.set(k,mode==='transaction'?{serviceHash:r.tx_hash,count:0,error:0,timeSum:0}:
    {classHash:r.classHash,serviceHash:r.serviceHash,msgHash:r.msg,msg:`Redacted example ${r.msg}`,count:0});
  const a=m.get(k);
  if(mode==='transaction') {a.count+=r.tx_count;a.error+=r.tx_error;a.timeSum+=r.tx_time_sum;}
  else a.count+=r.count;
 }
 return [...m.values()];
}
export function markdown(mode,shown){
 const columns=keys(mode);
 const header=`| ${columns.join(' | ')} |\n| ${columns.map(()=> '---').join(' | ')} |`;
 const display=r=>columns.map(k=>k==='time'?ftime(r.time):r[k]===undefined?'-':
   typeof r[k]==='number'&&!Number.isInteger(r[k])?r[k].toFixed(2):String(r[k]));
 return `## mxql/app/stat_${mode==='transaction'?'tx':'error'}_pcode\n\n**Period**: ${ftime(start)} → ${ftime(end)}\n\n> Result may be truncated (showing 4 rows).\n\n${header}\n${shown.map(r=>`| ${display(r).join(' | ')} |`).join('\n')}`;
}
