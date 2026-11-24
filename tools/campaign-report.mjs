/** F5: evidence-verified, read-only Korean campaign report + optional Codex incident diagnosis. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readTask,hashFile} from '../dist/workflow.js';
import {investigateRecoveredStats} from './frozen-stats-investigation.mjs';

const sha=s=>createHash('sha256').update(s).digest('hex');
const redact=value=>{
  let s=String(value??'');
  const names=['WHATAP_API_TOKEN','WHATAP_HTTP_API_TOKEN','GH_TOKEN','GITHUB_TOKEN','AWS_SECRET_ACCESS_KEY'];
  for(const name of names){const secret=process.env[name];if(secret)s=s.replaceAll(secret,'[REDACTED]');}
  return s.replace(/(Bearer\s+)[^\s]+/gi,'$1[REDACTED]')
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g,'[REDACTED]');
};
const safe=(v,max=4000)=>redact(v).replaceAll('|','\\|')
  .replace(/[<>]/g,c=>c==='<'?'&lt;':'&gt;').replace(/[\r\n]+/g,' ').slice(0,max);
export function validWindow(v){
  return !!v&&Number.isSafeInteger(v.stime)&&Number.isSafeInteger(v.etime)&&
    v.stime>0&&v.etime>v.stime&&v.etime<=8640000000000000;
}
export function formatWindow(v){
  if(!validWindow(v))return '미확보 (유효한 MCP Period 없음)';
  const date=x=>new Date(x).toLocaleString('sv-SE',{timeZone:'Asia/Seoul'})+' KST';
  return `${date(v.stime)} ~ ${date(v.etime)}`;
}
async function loadVerified(a,scenario){
  if(!a.evidence?.reportSha256)return {reason:a.reason||'EXECUTION_ERROR',verified:false,window:null};
  const path=join(a.evidence.runDir,'report.json');
  if(await hashFile(path)!==a.evidence.reportSha256)
    throw Error(`Campaign raw report SHA mismatch: ${a.phase} #${a.ordinal}`);
  const report=JSON.parse(await readFile(path,'utf8'));
  if(report.scenarios?.length!==1||report.scenarios[0].id!==scenario||
    report.scenarios[0].status!==a.verdict)throw Error('Campaign scenario/attempt mismatch');
  const r=report.scenarios[0];
  return {
    reason:r.reason,verified:true,
    // Ignore the legacy placeholder {stime:0,etime:0}; it is NOT a real MCP query.
    window:validWindow(r.timeWindow)?r.timeWindow:null,
    rowCount:r.reference?.rowCount??null,
    candidateRows:r.candidate?.parsedRows??r.reference?.statistics?.visibleMcpRows??null,
    stats: r.reference?.statistics?{
      mxqlRows:r.reference.statistics.fullMxqlRows??r.reference.statistics.mxql?.rowCount??null,
      v2Groups:r.reference.statistics.v2RowCount??null,
      comparedBuckets:r.reference.statistics.comparedBuckets??null,
      v2Window:r.reference.statistics.v2Window??null,
    }:null,
    candidateTool:r.mcpTool??null,
    relativeReplay:r.relativeReplayAudit??report.relativeReplayAudit??null,
    checks:r.checks?.map(c=>({code:c.code,ok:c.ok,detail:c.detail}))??[],
    resultSha256:a.evidence.reportSha256,runDir:a.evidence.runDir,
    candidateArgs:r.candidate?.args??null,
    candidatePath:r.mcpPath??null,
  };
}
export function recoveryClass(s){
  const attempts=(s.validationHistory||[]).filter(x=>x.phase==='INITIAL_VERIFY');
  if(s.phase==='DONE'&&s.status==='COMPLETED'&&s.latestValidation?.verdict==='PASS'){
    if(attempts.some(x=>x.verdict==='FAIL'))return 'RECOVERED_FAIL';
    if(attempts.some(x=>x.verdict==='UNVERIFIABLE'&&x.reason==='REFERENCE_INCONSISTENCY'))
      return 'RECOVERED_REFERENCE';
    if(attempts.some(x=>x.verdict==='UNMAPPED'))return 'RECOVERED_UNMAPPED';
    return 'PASS';
  }
  if(s.phase==='PR_OPEN'&&s.status==='PR_OPEN')return 'PR_OPEN';
  if(s.status==='CANCELLED')return 'BLOCKED_ARCHIVED';
  return `${s.phase}/${s.status}`;
}
const incidentSchema={type:'object',additionalProperties:false,
  required:['classification','summary','plausibleCauses','confirmedFacts','unknowns','nextVerification'],
  properties:{classification:{type:'string',enum:['TRANSIENT_BACKEND','WINDOW_SHIFT','MCP_DEFECT_UNPROVEN','OTHER_UNPROVEN']},
    summary:{type:'string'},plausibleCauses:{type:'array',items:{type:'string'}},
    confirmedFacts:{type:'array',items:{type:'string'}},unknowns:{type:'array',items:{type:'string'}},
    nextVerification:{type:'array',items:{type:'string'}}}};
const allowedClasses=['TRANSIENT_BACKEND','WINDOW_SHIFT','MCP_DEFECT_UNPROVEN','OTHER_UNPROVEN'];
function validateAI(obj){
  if(!obj||typeof obj!=='object'||!allowedClasses.includes(obj.classification)||
    typeof obj.summary!=='string'||!['plausibleCauses','confirmedFacts','unknowns','nextVerification']
      .every(k=>Array.isArray(obj[k])&&obj[k].every(x=>typeof x==='string')))
    throw Error('Codex incident diagnosis is not a complete structured JSON object');
  return obj;
}
/** Credentials are removed. Never requests live MCP/HTTP or authorizes edits. */
export async function readOnlyIncidentAI(context,{worktree,taskDir,bin='codex',timeoutMs=180000}={}){
  const filename=join(taskDir,'incident-ai-'+randomUUID().slice(0,8));
  const schemaFile=filename+'-schema.json',outputFile=filename+'-result.json';
  const debugFile=filename+'-diagnostics.json';
  await writeFile(schemaFile,JSON.stringify(incidentSchema)+'\n',{flag:'wx',mode:0o600});
  const prompt=[
    'WhaTap MCP 검증 불일치에 대한 읽기 전용 사후 분석을 한국어 JSON 으로 작성하세요.',
    '소스 변경, 네트워크, Git, MCP 도구 호출을 하지 마세요. 제공된 저장 증거 요약만 사용하세요.',
    'FAIL 이후 PASS 는 동일 기간 재조회가 아니라면 실제 원인이나 MCP 수정 성공을 증명하지 않습니다.',
    '확인 사실과 가설을 구분하고, 확인되지 않은 원인은 미확정으로 기록하세요.',
    JSON.stringify(context),
  ].join('\n');
  const env={...process.env};
  for(const name of Object.keys(env))if(/^(WHATAP_|AWS_|GH_TOKEN$|GITHUB_TOKEN$|GIT_ASKPASS$|SSH_AUTH_SOCK$)/i.test(name))delete env[name];
  // Avoid optional flags whose support varies with Codex CLI versions;
  // explicitly disable known MCPs, keep read-only sandbox, and record stderr if rejected.
  const args=['exec','--json','--ephemeral','--sandbox','read-only','--skip-git-repo-check',
    '-c','mcp_servers.whatap.enabled=false','-c','mcp_servers.whatap-http.enabled=false',
    '--output-schema',schemaFile,'--output-last-message',outputFile,prompt];
  const runOnce=()=>new Promise((finish)=>{
    const child=spawn(bin,args,{cwd:worktree,env,stdio:['ignore','pipe','pipe'],shell:false});
    let stderr='',stdout='',expired=false,excess=false,done=false;
    const timer=setTimeout(()=>{expired=true;child.kill('SIGTERM');
      setTimeout(()=>child.kill('SIGKILL'),3000).unref();},timeoutMs);
    const complete=(result)=>{if(done)return;done=true;clearTimeout(timer);finish(result);};
    child.stdout.on('data',b=>{if(stdout.length<4000)stdout+=b.toString();else excess=true;});
    child.stderr.on('data',b=>{if(stderr.length<12000)stderr+=b.toString();});
    child.once('error',e=>complete({code:-1,expired,excess,stderr:String(e),stdout}));
    child.once('close',c=>complete({code:c??-1,expired,excess,stderr,stdout}));
  });
  let result,attempts=0;
  while(attempts<2){
    attempts++;
    result=await runOnce();
    if(result.code===0&&!result.expired&&!result.excess)break;
    const msg=result.stderr+' '+result.stdout;
    // Retry only likely transient API/transport failures, never malformed CLI args.
    if(attempts>=2||!/(?:rate.limit|429|timed? out|temporary|connection.reset|503|overloaded)/i.test(msg))break;
  }
  const debug={version:1,attempts,exitCode:result.code,timeout:result.expired,
    outputTooLarge:result.excess,stderr:safe(result.stderr,1800),
    stdoutSha256:sha(result.stdout),argsFlags:args.filter(a=>a.startsWith('--')).filter(x=>x!=='--output-schema'&&x!=='--output-last-message')};
  await writeFile(debugFile,JSON.stringify(debug,null,2)+'\n',{flag:'wx',mode:0o600});
  if(result.code!==0||result.expired||result.excess)
    throw Error(`Codex incident exit=${result.code} timeout=${result.expired}; stderr=${safe(result.stderr,600)}; diagnostics=${debugFile}`);
  return validateAI(JSON.parse(await readFile(outputFile,'utf8')));
}
function detailHeading(item,attempt){return `### ${attempt.phase} #${attempt.ordinal} — ${attempt.verdict}`;}
function firstValidWindow(evidence){return evidence.find(x=>
  (x.verdict==='FAIL'||x.evidence.reason==='REFERENCE_INCONSISTENCY')&&validWindow(x.evidence.window))?.evidence.window??null;}
export async function writeCampaignReport({outputDir,results,worktree,config=null,
  analyzeRecovered=true,incidentAnalyzer=readOnlyIncidentAI,
  frozenInvestigator=investigateRecoveredStats}){
  const dir=resolve(outputDir,'campaign');await mkdir(dir,{recursive:true,mode:0o700});
  const summary=[],detailsSections=[],rows=[];
  const columns='| 시나리오 | 최종 분류 | 초기 PASS | 초기 FAIL | 초기 UNMAPPED | 초기 UNVERIFIABLE | 수정 시도 | PR |';
  const divider='|---|---|---:|---:|---:|---:|---:|---|';
  for(const item of results){
    if(!item.taskId)continue;
    const state=await readTask(outputDir,item.taskId);
    const attempts=state.validationHistory??[];
    const classification=recoveryClass(state);
    const count=verdict=>attempts.filter(a=>a.phase==='INITIAL_VERIFY'&&a.verdict===verdict).length;
    const pass=count('PASS'),fails=count('FAIL'),unmapped=count('UNMAPPED'),unknowns=count('UNVERIFIABLE');
    summary.push(`| ${safe(item.scenarioId)} | ${safe(classification)} | ${pass} | ${fails} | ${unmapped} | ${unknowns} | ${state.editHistory?.length??0} | ${safe(state.submission?.prUrl??'없음')} |`);
    const evidence=[];
    for(const attempt of attempts){
      evidence.push({phase:attempt.phase,ordinal:attempt.ordinal,verdict:attempt.verdict,
        evidence:await loadVerified(attempt,item.scenarioId)});
    }
    const rec={scenarioId:item.scenarioId,taskId:item.taskId,classification,details:evidence,
      editHistory:state.editHistory??[],prUrl:state.submission?.prUrl??null};
    const referenceIssues=evidence.filter(d=>d.phase==='INITIAL_VERIFY' &&
      d.verdict==='UNVERIFIABLE'&&d.evidence.reason==='REFERENCE_INCONSISTENCY');
    if(analyzeRecovered&&((fails&&pass)||referenceIssues.length)){
      const firstFail=evidence.find(d=>d.phase==='INITIAL_VERIFY'&&
        (d.verdict==='FAIL'||d.evidence.reason==='REFERENCE_INCONSISTENCY'));
      const recoveredPass=evidence.filter(d=>d.phase==='INITIAL_VERIFY'&&d.verdict==='PASS').at(-1);
      if(config){
        const scenario=config.scenarios?.find(x=>x.id===item.scenarioId);
        if(scenario?.statisticsMode && ['STATS_AGGREGATE_DIFFERENCE','REFERENCE_INCONSISTENCY'].includes(firstFail?.evidence?.reason)){
          try{
            rec.frozenInvestigation=await frozenInvestigator({scenario,firstFail,taskId:item.taskId,
              outputDir,referenceEntry:config.servers.reference,timeoutMs:config.rpcTimeoutMs});
          }catch(e){
            // A tampered saved HTTP response must halt report publication, not be hidden.
            if(/SHA mismatch/.test(String(e)))throw e;
            rec.frozenInvestigation={status:'UNVERIFIABLE',reason:safe(e,900)};
          }
        }
      }
      const forensic=rec.frozenInvestigation;
      // A recovered reference discrepancy is not an MCP fix. Independently label
      // disappearance of the reference conflict, with no backdated PASS.
      if(referenceIssues.length){
        const matched=(forensic?.snapshots??[]).filter(x=>x.status==='MATCH');
        const differed=(forensic?.snapshots??[]).filter(x=>x.status==='DIFFERENCE');
        rec.referenceDisposition=forensic?.status==='COMPLETED'&&matched.length>=2&&
          (forensic.bucketProbes??[]).every(x=>x.status==='MATCH')
          ? 'TRANSIENT_REFERENCE' : forensic?.status==='COMPLETED'&&differed.length>=2
            ? 'PERSISTENT_REFERENCE' : 'REFERENCE_INCONSISTENCY_UNRESOLVED';
      }
      const context={scenarioId:item.scenarioId,firstFail,recoveredPass,
        referenceOnly:referenceIssues.length>0,
        ...(forensic?{independentFrozenHttpForensics:{status:forensic.status,
          originalWindow:forensic.initial?.window??firstFail.evidence.window,
          initial:forensic.initial?{mxqlGroups:forensic.initial.mxqlGroups,v2Groups:forensic.initial.v2Groups,
            different:forensic.initial.different,missingV2:forensic.initial.missingV2}:null,
          snapshots:(forensic.snapshots??[]).map(v=>({status:v.status,at:v.at,counts:v.counts?
            {mxqlGroups:v.counts.mxqlGroups,v2Groups:v.counts.v2Groups,different:v.counts.different,
              missingV2:v.counts.missingV2}:null})),
          bucketProbeCounts:(forensic.bucketProbes??[]).map(v=>({window:v.window,status:v.status,
            differences:v.counts?.different,missingV2:v.counts?.missingV2}))}}:{}),
        note:'MCP 응답 Period 별로 독립 HTTP 와 비교합니다. REFERENCE_INCONSISTENCY 는 MCP 결함이 아니며, 고정기간 HTTP 사후 재조회만으로 수정 권한을 주지 않습니다.'};
      try{
        rec.incidentAI=await incidentAnalyzer(context,{worktree,taskDir:dir});
        rec.analysisStatus='CODEX_READ_ONLY_ANALYSIS_COMPLETED';
      }catch(e){
        rec.analysisStatus='AI_ANALYSIS_UNAVAILABLE';
        rec.analysisError=safe(e instanceof Error?e.message:e,1100);
        rec.unconfirmedIncident={
          confirmed:'저장된 한 기간의 MCP/HTTP 비교가 FAIL 이었으며 이후 다른 기간의 검증은 PASS 로 기록됨',
          unknown:'시간 간격만으로 실패 원인 또는 MCP 코드 결함을 입증할 수 없음',
          next:'원본 FAIL 증거를 보존하고 집계 경계 및 두 API 의 갱신 시점 차이를 조사해야 함',
        };
      }
    }
    rows.push(rec);
    const block=[`## ${safe(item.scenarioId)}`,`- Task: \`${safe(item.taskId)}\``,`- 최종 분류: **${safe(classification)}**`];
    for(const d of evidence){
      block.push(detailHeading(item,d),`- 관찰 기간: ${formatWindow(d.evidence.window)}`,
        `- 근거: ${safe(d.evidence.reason)}`,
        `- 증거 SHA-256: \`${d.evidence.resultSha256??'없음'}\``,
        ...(d.evidence.stats?[
          `- MCP 표시 행: ${d.evidence.candidateRows??'미확보'}행 (전체 MCP 반환량이 아님)`,
          `- HTTP MXQL 전체 원본: ${d.evidence.stats.mxqlRows??'미확보'}행`,
          `- HTTP v2 통계 집계: ${d.evidence.stats.v2Groups??'미확보'}그룹`,
          `- 통계 버킷: ${d.evidence.stats.comparedBuckets??'미확보'}개 (5분 간격)`
        ]:[`- MCP 표시 행 / HTTP 반환 행: ${d.evidence.candidateRows??'미확보'} / ${d.evidence.rowCount??'미확보'}`]));
      if(d.evidence.relativeReplay)block.push('- 재조회 방식: 이전 SHA 검증 MCP 상대시간 호출 인자 고정 (MCP 는 새로운 Period 반환)');
      if(d.verdict==='UNMAPPED')block.push('- 이 회차는 동등한 MCP 조회가 확인되지 않아 실제 측정 기간이 없습니다. 자동 PASS 또는 자동 수정 대상이 아닙니다.');
      for(const check of d.evidence.checks??[]){
        if(!check.ok)block.push(`- **불일치 검사 ${safe(check.code)}:** ${safe(check.detail)}`);
      }
    }
    if(rec.referenceDisposition){
      block.push(`### F6 독립 기준 데이터 분류: **${rec.referenceDisposition}**`,
        '- HTTP 기준의 후속 일치가 확인되더라도 최초 불일치의 실제 발생 사실이나 MCP 결함의 존재 여부를 소급 변경하지 않습니다.',
        '- 백엔드 원인 및 최초 차이의 내부 발생 지점은 별도 증거 없이는 미확정입니다.');
    }
    if(rec.frozenInvestigation){
      const x=rec.frozenInvestigation;
      block.push('### F6 최초 기준 불일치 기간 고정 HTTP 사후 재조회 (읽기 전용)',
        `- 조사 상태: **${safe(x.status)}**`,
        `- 최초 FAIL 기간: ${formatWindow(firstValidWindow(evidence))}`,
        '- 원래 MCP 의 상대시간 도구는 고정 기간으로 다시 호출하지 않습니다. HTTP MXQL/v2 만 동일 절대기간으로 다시 조회합니다.');
      if(x.reason)block.push(`- 조사 제한 또는 오류: ${safe(x.reason)}`);
      if(x.manifestPath)block.push(`- 독립 조사 증거 목록: \`${safe(x.manifestPath)}\`; SHA-256 ${safe(x.manifestSha256??'미확보')}`);
      if(x.initial){
        const a=x.initial;
        block.push(`- 최초 저장 HTTP 집계: MXQL ${a.mxqlGroups}그룹 / v2 ${a.v2Groups}그룹; 값 차이 ${a.different}, v2 누락 ${a.missingV2}, MXQL 누락 ${a.missingMxql}`,
          `- 최초 전체 그룹별 실측 CSV: \`${safe(x.manifestPath?.replace(/manifest\.json$/,'')+a.groupCsv?.file)}\` (SHA-256 ${a.groupCsv?.sha256})`);
      }
      for(const snap of x.snapshots??[]){
        const a=snap.counts;
        block.push(`- 고정 기간 HTTP 재조회 #${snap.index}: ${safe(snap.status)}; ${safe(snap.at)}; `+
          (a?`MXQL ${a.mxqlGroups}그룹 / v2 ${a.v2Groups}그룹 / 차이 ${a.different} / v2 누락 ${a.missingV2}`:safe(snap.error??'미확보')));
        if(snap.groupCsv)block.push(`  - 전체 그룹 CSV: \`${safe(x.manifestPath?.replace(/manifest\.json$/,'')+snap.groupCsv.file)}\` (SHA-256 ${snap.groupCsv.sha256})`);
      }
      const probes=x.bucketProbes??[];
      if(probes.length){
        block.push(`- 5분 버킷별 독립 v2 확인: ${probes.length}개; PASS=${probes.filter(v=>v.status==='MATCH').length}, 불일치=${probes.filter(v=>v.status==='DIFFERENCE').length}, 확인 불가=${probes.filter(v=>v.status==='UNVERIFIABLE').length}`);
        for(const b of probes){
          const a=b.counts;
          block.push(`  - ${formatWindow(b.window)}: ${safe(b.status)}; `+
            (a?`MXQL ${a.mxqlGroups}그룹 / v2 ${a.v2Groups}그룹; 값 차이 ${a.different}, 누락 ${a.missingV2}`:safe(b.error??'미확보')));
        }
        block.push('- 버킷의 MXQL 값은 마지막 검증된 전체기간 HTTP 응답에서 해당 버킷 행만 추출한 값입니다. v2 는 버킷마다 별도로 HTTP 요청했습니다.');
      }
      block.push('- 조사 결과는 MCP 수정 권한, 기존 FAIL 판정의 소급 취소 또는 원인 확정에 사용하지 않습니다.');
    }
    if(rec.incidentAI){
      const x=rec.incidentAI;
      block.push('### 검증 불일치에 대한 Codex 읽기 전용 사후 분석',
        `- 분류: ${safe(x.classification)} — **수정 권한을 부여하지 않음**`,
        `- 요약: ${safe(x.summary)}`,
        ...x.confirmedFacts.map(v=>`- 확인 사실: ${safe(v)}`),
        ...x.plausibleCauses.map(v=>`- 가능성(미확정): ${safe(v)}`),
        ...x.unknowns.map(v=>`- 미확인: ${safe(v)}`),
        ...x.nextVerification.map(v=>`- 추가 확인: ${safe(v)}`));
    }else if(rec.analysisStatus){
      block.push('### 검증 불일치의 분석 상태',
        `- ${rec.analysisStatus}: ${rec.analysisError}`,
        `- 확인 사실: ${rec.unconfirmedIncident.confirmed}`,
        `- 미확인: ${rec.unconfirmedIncident.unknown}`,
        `- 추가 확인: ${rec.unconfirmedIncident.next}`);
    }
    detailsSections.push(block.join('\n'));
  }
  // All table rows are contiguous; never interleave markdown headings within a table.
  const lines=['# WhaTap MCP 자동 캠페인 통합 검증 보고서','',
    '본 보고서는 모든 시나리오와 재검증 이력을 요약합니다. 저장된 JSON 원본의 SHA-256 일치 여부를 확인했습니다.',
    '상대시간 Period 가 다른 재조회는 동일 레코드의 수정 전후 데이터 비교로 표기하지 않습니다.','',
    columns,divider,...summary,'',...detailsSections.flatMap(s=>[s,'']),
    '## 운영 결론',
    '- PASS 는 그 회차의 MCP/HTTP 비교 결과가 일치했다는 뜻입니다.',
    '- RECOVERED_UNMAPPED 는 처음에 LLM 이 경로를 찾지 못했지만 안전한 재탐색으로 검증 가능한 조회에 성공했다는 뜻입니다.',
    '- RECOVERED_FAIL 은 MCP 결함 후보 FAIL 이 후속 다른 기간에서 PASS 한 것으로, 결함 해결 증명은 아닙니다.',
    '- RECOVERED_REFERENCE 는 MCP 표시 행이 일치했으나 HTTP 기준끼리 불일치한 기간의 증거가 보존되고, 이후 다른 관찰에서 기준이 일치했다는 뜻입니다. MCP 수정은 허용되지 않습니다.',
    '- REFERENCE_INCONSISTENCY 는 검증 기준의 충돌로, 독립 HTTP 사후 조사 대상이며 MCP 코드 수정 승인 사유가 아닙니다.',
    '- TRANSIENT_REFERENCE 는 고정된 HTTP 기간에서 추후 기준 간 일치가 확인된 경우를 뜻하며 백엔드 내부 원인이나 MCP 결함을 입증하지 않습니다.',
    '- Codex 가 실패한 사후 분석은 그 사실과 stderr 진단 근거를 기록하며 실제 원인이 밝혀졌다고 주장하지 않습니다.',
    '- 원인 가설은 자동 수정 권한이 아니며, 독립 PRE_FIX_VERIFY 2회 FAIL 통과 후에만 변경을 허용합니다.',
    '- 사람의 PR Merge 승인 전까지 Harness 는 변경을 병합하지 않습니다.'];
  const payload={version:4,generatedAt:new Date().toISOString(),tasks:rows};
  const jsonPath=join(dir,'latest-report.json'),mdPath=join(dir,'latest-report.md');
  await writeFile(jsonPath,JSON.stringify(payload,null,2)+'\n',{mode:0o600});
  await writeFile(mdPath,lines.join('\n')+'\n',{mode:0o600});
  return {jsonPath,mdPath,rows};
}
