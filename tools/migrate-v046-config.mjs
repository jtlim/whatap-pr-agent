#!/usr/bin/env node
/** Preserve existing user config and change only the two verified APM statistics mappings. */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
const file=resolve(process.argv[2]??'config/harness.json');
const data=JSON.parse(await readFile(file,'utf8'));
if(!Array.isArray(data.scenarios))throw Error('Scenario array missing');
const mappings={
 'apm-transaction-stats':{
  statisticsMode:'transaction',mcpPath:'mxql/app/stat_tx_pcode',allowedMcpPaths:['mxql/app/stat_tx_pcode'],
  matchKeys:['time','tx_hash','oid','okind','pcode'],compareFields:['tx_count','tx_error','tx_time_sum'],
  userRequest:'프로젝트 5490 의 최근 1시간 서비스별 APM 트랜잭션 통계(호출 건수, 오류 건수, 응답시간 합계)를 조회해 줘. 실행 가능한 통계 MXQL 경로를 찾아 조회하고, 반환이 제한되면 그 사실도 알려줘.'
 },
 'apm-exception-stats':{
  statisticsMode:'exception',mcpPath:'mxql/app/stat_error_pcode',allowedMcpPaths:['mxql/app/stat_error_pcode'],
  matchKeys:['time','classHash','serviceHash','oid'],compareFields:['count'],
  userRequest:'프로젝트 5490 의 최근 1시간 APM Exception 클래스·서비스·메시지별 발생 통계를 조회해 줘. 실행 가능한 통계 MXQL 경로를 찾아 조회하고, 반환이 제한되면 그 사실도 알려줘.'
 }
};
const oldDefault={
 'apm-transaction-stats':'프로젝트 5490 의 APM 트랜잭션 통계를 최근 1시간 기준으로 조회해서 알려줘.',
 'apm-exception-stats':'프로젝트 5490 의 APM 예외(Exception) 발생 통계를 최근 1시간 기준으로 조회해서 알려줘.'
};
for(const [id, patch] of Object.entries(mappings)){
 const s=data.scenarios.find(x=>x.id===id);
 if(!s)throw Error(`Required scenario missing: ${id}`);
 if(s.projectCode!==5490||s.referenceTool!==(id==='apm-transaction-stats'?'whatap_http_apm_transactions':'whatap_http_apm_errors')){
  throw Error(`${id} project/reference tool changed: refusing automatic migration`);
 }
 const preserveRequest=s.userRequest!==undefined&&s.userRequest!==oldDefault[id];
 const request=s.userRequest;
 Object.assign(s,patch);
 if(preserveRequest)s.userRequest=request;
}
const temp=file+'.tmp-v046-'+process.pid;
await writeFile(temp,JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
await rename(temp,file);
console.log('통계 시나리오 2개 매핑 완료 (기존 다른 설정 및 사용자 지정 요청 보존)');
