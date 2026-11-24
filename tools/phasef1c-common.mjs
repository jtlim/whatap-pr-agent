// Pure and offline-testable helpers for a LIVE, read-only fixed-window probe.
// This is a qualification probe, never a Harness task transition or edit authority.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve, sep} from 'node:path';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export function parseArgs(argv) {
  const valid = new Set(['--config','--candidate','--scenario','--minutes','--lag-minutes','--limit','--stime','--etime']);
  const parsed = new Map();
  let confirmLive = false;
  for (let i=0;i<argv.length;i++) {
    const k = argv[i];
    if (k==='--confirm-live-read-only') {
      if (confirmLive) throw Error('duplicate --confirm-live-read-only');
      confirmLive=true; continue;
    }
    if (!valid.has(k) || parsed.has(k) || i+1>=argv.length || argv[i+1].startsWith('--')) throw Error(`Invalid option ${k}`);
    parsed.set(k, argv[++i]);
  }
  const number = (name, def, min, max) => {
    const raw=parsed.get(name);
    if(raw===undefined)return def;
    if(!/^(0|[1-9]\d*)$/.test(raw))throw Error(`Invalid ${name}`);
    const n=Number(raw);
    if(!Number.isSafeInteger(n)||n<min||n>max)throw Error(`Invalid ${name}`);
    return n;
  };
  return {
    confirmLive,
    config:parsed.get('--config')??'config/harness.json',
    candidate:parsed.get('--candidate'),
    scenario:parsed.get('--scenario')??'apm-tps-series',
    minutes:number('--minutes',5,1,60),
    lagMinutes:number('--lag-minutes',30,15,1440),
    limit:number('--limit',1000,1,10000),
    stime:number('--stime',null,1,Number.MAX_SAFE_INTEGER),
    etime:number('--etime',null,1,Number.MAX_SAFE_INTEGER),
  };
}
export function fixedWindow(opts,now=Date.now()) {
  if((opts.stime===null)!==(opts.etime===null))throw Error('Specify --stime and --etime together');
  let stime,etime;
  if(opts.stime!==null){stime=opts.stime;etime=opts.etime;}
  else {
    // 1 second off the 5-second boundary: avoids known bucket start/end ambiguity.
    etime=Math.floor((now-opts.lagMinutes*60_000)/5000)*5000+1000;
    stime=etime-opts.minutes*60_000;
  }
  if(!Number.isSafeInteger(stime)||!Number.isSafeInteger(etime)||stime<=0||etime<=stime||
     stime%1000!==0||etime%1000!==0||(etime-stime)%60_000!==0||
     etime-stime>60*60_000||etime>now-10*60_000)throw Error('Unsafe or invalid fixed time window');
  return {stime,etime};
}
export async function integrityCheckedArtifact(runDir,meta) {
  if(!meta || typeof meta.file!=='string' || !/^[0-9a-f]{64}$/.test(meta.sha256??''))
    throw Error('Missing evidence file or SHA-256');
  const full=resolve(runDir,meta.file),root=resolve(runDir);
  if(!full.startsWith(root+sep))throw Error('Evidence path escape');
  const data=await readFile(full);
  if(sha256(data)!==meta.sha256)throw Error('Evidence integrity failure');
  return JSON.parse(data.toString('utf8'));
}
/**
 * Repeat stability is about the HTTP *data rows*, not transport/request metadata.
 * Keep all measured row columns (including fields outside compareFields), preserve
 * duplicates and nested array order, but canonicalize object-key and row order.
 * Raw response SHA-256 is checked separately by integrityCheckedArtifact.
 */
function canonicalJson(value) {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  const json = JSON.stringify(value);
  if (typeof json !== 'string') throw Error('Unsupported JSON value in reference rows');
  return json;
}
export function referenceRowsDigest(reference) {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference))
    throw Error('Unexpected reference response envelope');
  const body = reference.body;
  const source = Array.isArray(body) ? body
    : body && typeof body === 'object' && !Array.isArray(body) && Array.isArray(body.data)
      ? body.data : null;
  if (!source) throw Error('Missing reference data rows');
  const rows = source.filter(item => !(item && typeof item === 'object' &&
    !Array.isArray(item) && Object.hasOwn(item, '_head_')));
  if (!rows.length || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row)))
    throw Error('Reference data rows empty or malformed');
  const canonicalRows = rows.map(canonicalJson).sort();
  return {sha256:sha256(JSON.stringify(canonicalRows)),rowCount:rows.length};
}

export async function evaluateStoredRun(report, extractContent) {
  const s=report.scenarios?.[0];
  if (!s) throw Error('Missing scenario report');
  const hashes={valid:false,candidate:null,reference:null,referenceEvidence:s.reference?.sha256??null};
  try {
    const candidate=await integrityCheckedArtifact(report.runDir,s.candidate);
    const reference=await integrityCheckedArtifact(report.runDir,s.reference);
    hashes.valid=true;
    hashes.candidate=sha256(JSON.stringify(extractContent(candidate)));
    const digest=referenceRowsDigest(extractContent(reference));
    if (digest.rowCount===s.reference?.rowCount) hashes.reference=digest.sha256;
  } catch { // Never turn missing, corrupted, or unparseable evidence into PASS.
  }
  return summarizeRun(report,hashes);
}

export function summarizeRun(report, hashes) {
  const s=report.scenarios?.[0];
  const audit=report.fixedReplayAudit??{};
  if(!s)throw Error('Missing scenario report');
  const matched = audit.periodMatched===true &&
    audit.requestedWindow?.stime===s.timeWindow?.stime &&
    audit.requestedWindow?.etime===s.timeWindow?.etime;
  const fullCoverage = Number.isSafeInteger(s.reference?.rowCount)&&s.reference.rowCount>0&&
    s.candidate?.parsedRows===s.reference.rowCount &&
    !s.checks?.some(c=>c.code==='MCP_LIMIT_NOTICE');
  const required=['HTTP_OK','PARSE_ROWS','TIME_WINDOW','REFERENCE_REQUEST','MATCH_KEYS','MCP_SUMMARY'];
  const checksOk=required.every(code=>s.checks?.some(c=>c.code===code&&c.ok===true)) &&
    !s.checks?.some(c=>c.ok===false);
  const passed = s.status==='PASS'&&matched&&fullCoverage&&checksOk&&
    audit.schemaVerdict==='SCHEMA_CANDIDATE'&&audit.toolCalls===1&&hashes.valid&&
    typeof hashes.candidate==='string'&&typeof hashes.reference==='string';
  return {status:s.status,reason:s.reason,requestedPeriodMatched:matched,
    declaredSchema:audit.schemaVerdict,toolCalls:audit.toolCalls,
    displayedRows:s.candidate?.parsedRows??null,referenceRows:s.reference?.rowCount??null,
    fullCoverage,requiredChecksPassed:checksOk,evidenceIntegrity:hashes.valid,
    eligible:passed,hashes:{candidate:hashes.candidate??null,reference:hashes.reference??null,
      referenceEvidence:hashes.referenceEvidence??null},
    evidenceDirectory:report.runDir};
}
export function overall(a,b) {
  const stable = !!a.hashes.candidate && !!b.hashes.candidate &&
    a.hashes.candidate===b.hashes.candidate && !!a.hashes.reference &&
    a.hashes.reference===b.hashes.reference;
  const verdict=a.eligible && b.eligible && stable ? 'PASS' :
    a.status==='FAIL'||b.status==='FAIL' ? 'FAIL' : 'UNVERIFIABLE';
  return {verdict,stable,reason:verdict==='PASS'?'Both fixed-window comparisons and canonical reference data rows agree':
    !a.eligible||!b.eligible?'One or both independent comparisons did not meet strict full-coverage requirements':
    'Candidate output or canonical reference data rows changed between fixed-window reads'};
}
