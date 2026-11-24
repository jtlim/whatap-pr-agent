/** F1-B fixed-window replay contract. No AI is permitted to re-select query arguments. */
import type { ScenarioReport } from './types.js';

export type FixedWindow = {stime:number;etime:number};
export type FixedReplay = { originalArgs:Record<string,unknown>; mcpPath:string; window:FixedWindow };
const isObj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const validWindow=(w:FixedWindow):boolean=>Number.isSafeInteger(w.stime)&&Number.isSafeInteger(w.etime)&&
  w.stime>0&&w.etime>w.stime;
const omitTime=(args:Record<string,unknown>)=>Object.keys(args).filter(x=>!['timeRange','stime','etime'].includes(x))
  .sort().map(k=>[k,args[k]] as [string,unknown]);

/** Query identity includes every non-time argument; no replacement of path/limit/params/query. */
export function replayQuerySignature(mcpPath:string|null,args:Record<string,unknown>|undefined):string|null {
  if(!mcpPath||!args||typeof args.projectCode!=='number'||!Number.isSafeInteger(args.projectCode)||
     typeof args.path!=='string'||args.path!==mcpPath)return null;
  try{return JSON.stringify({mcpPath,args:omitTime(args)});}catch{return null;}
}
export function fixedReplayFromBaseline(r:ScenarioReport):FixedReplay {
  if(r.callResults?.length||r.status!=='FAIL'||r.mcpTool!=='whatap_query_data')
    throw Error('Fixed replay requires one failed original whatap_query_data call');
  const a=r.candidate.args,w=r.timeWindow;
  if(!a||!isObj(a)||typeof a.timeRange!=='string'||!a.timeRange.trim()||
      Object.hasOwn(a,'stime')||Object.hasOwn(a,'etime')||!validWindow(w)||
      !replayQuerySignature(r.mcpPath,a))throw Error('Original query cannot be replayed at an exact absolute Period');
  // JSON copy avoids aliasing historical evidence objects. Only saved original tool args are used.
  return {originalArgs:JSON.parse(JSON.stringify(a)) as Record<string,unknown>,mcpPath:r.mcpPath!,window:{...w}};
}
export function fixedReplayArgs(replay:FixedReplay):Record<string,unknown> {
  if(!isObj(replay.originalArgs)||typeof replay.originalArgs.timeRange!=='string'||
     Object.hasOwn(replay.originalArgs,'stime')||Object.hasOwn(replay.originalArgs,'etime')||
     !validWindow(replay.window)||!replayQuerySignature(replay.mcpPath,replay.originalArgs))
    throw Error('Invalid fixed-window replay request');
  const args={...replay.originalArgs};delete args.timeRange;
  return {...args,stime:replay.window.stime,etime:replay.window.etime};
}
export function sameFixedQuery(expected:FixedReplay,observed:ScenarioReport):boolean {
  const args=observed.candidate.args;
  if(!args||!replayQuerySignature(observed.mcpPath,args))return false;
  const expectedArgs=fixedReplayArgs(expected);
  return JSON.stringify(Object.keys(args).sort().map(k=>[k,args[k]]))===
    JSON.stringify(Object.keys(expectedArgs).sort().map(k=>[k,expectedArgs[k]]))&&
    observed.mcpPath===expected.mcpPath;
}

/** F2: direct re-execution of the original relative MCP call, with no AI argument changes.
 * Each result is compared to independently queried HTTP data using its OWN returned Period.
 * Different read periods are never represented as an exact historical replay. */
export type RelativeReplay={originalArgs:Record<string,unknown>;mcpPath:string};
export function relativeReplayFromBaseline(r:ScenarioReport):RelativeReplay{
  if(r.callResults?.length||r.status!=='FAIL'||r.mcpTool!=='whatap_query_data')
    throw Error('Relative replay requires a single failed original whatap_query_data call');
  const a=r.candidate.args;
  if(!a||!isObj(a)||typeof a.timeRange!=='string'||!/^\d+[smhdw]$/.test(a.timeRange)||
    Object.hasOwn(a,'stime')||Object.hasOwn(a,'etime')||!replayQuerySignature(r.mcpPath,a))
    throw Error('Original relative MCP call cannot be reproduced safely');
  return {originalArgs:JSON.parse(JSON.stringify(a)) as Record<string,unknown>,mcpPath:r.mcpPath!};
}
export function relativeReplayArgs(replay:RelativeReplay):Record<string,unknown>{
  const a=replay.originalArgs;
  if(!isObj(a)||typeof a.timeRange!=='string'||!/^\d+[smhdw]$/.test(a.timeRange)||
    Object.hasOwn(a,'stime')||Object.hasOwn(a,'etime')||!replayQuerySignature(replay.mcpPath,a))
    throw Error('Invalid original relative query');
  return JSON.parse(JSON.stringify(a)) as Record<string,unknown>;
}
export function sameRelativeQuery(replay:RelativeReplay,r:ScenarioReport):boolean{
  const a=r.candidate.args;
  if(!a||r.mcpPath!==replay.mcpPath)return false;
  try{
    return JSON.stringify(Object.keys(relativeReplayArgs(replay)).sort().map(k=>[k,replay.originalArgs[k]]))===
      JSON.stringify(Object.keys(a).sort().map(k=>[k,a[k]]));
  }catch{return false;}
}
