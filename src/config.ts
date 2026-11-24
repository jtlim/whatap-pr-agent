import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { HarnessConfig, Scenario } from './types.js';

const ALLOWED_REFERENCE_TOOLS = new Set([
  'whatap_http_server_metrics', 'whatap_http_apm_transactions',
  'whatap_http_apm_errors', 'whatap_http_apm_tps_series',
  'whatap_http_apm_error_series',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validScenario(s: unknown): s is Scenario {
  if (!isRecord(s)) return false;
  return typeof s.id === 'string' && /^[a-z][a-z0-9-]*$/.test(s.id) &&
    ['server', 'apm', 'timeseries'].includes(String(s.domain)) &&
    typeof s.description === 'string' &&
    Number.isSafeInteger(s.projectCode) && Number(s.projectCode) > 0 &&
    Number.isSafeInteger(s.stime) && Number.isSafeInteger(s.etime) &&
    Number(s.stime) > 0 && Number(s.etime) > Number(s.stime) &&
    typeof s.referenceTool === 'string' && ALLOWED_REFERENCE_TOOLS.has(s.referenceTool) &&
    (s.mcpPath === null || (typeof s.mcpPath === 'string' && /^(?:v2|mxql)\/[a-z0-9_/-]+$/.test(s.mcpPath))) &&
    (s.expectedDuration === undefined || (typeof s.expectedDuration === 'string' && /^[1-9]\d*[smhdw]$/.test(s.expectedDuration))) &&
    (s.userRequest === undefined || (typeof s.userRequest === 'string' && s.userRequest.length > 0)) &&
    (s.allowedMcpPaths === undefined || (Array.isArray(s.allowedMcpPaths) && s.allowedMcpPaths.every(v=>typeof v==='string' && /^(?:v2|mxql)\/[a-z0-9_/-]+$/.test(v)))) &&
    (s.matchKeys === undefined || (Array.isArray(s.matchKeys) && s.matchKeys.every(v => typeof v === 'string'))) &&
    (s.compareFields === undefined || (Array.isArray(s.compareFields) && s.compareFields.every(v => typeof v === 'string'))) &&
    (s.absoluteTolerance === undefined || (typeof s.absoluteTolerance === 'number' && s.absoluteTolerance >= 0)) &&
    (s.statisticsMode === undefined || (['transaction','exception'].includes(String(s.statisticsMode)) && s.domain === 'apm')) &&
    (s.expectedStepMs === undefined || (Number.isSafeInteger(s.expectedStepMs) && Number(s.expectedStepMs) > 0)) &&
    (s.mcpTimeRange === undefined || (typeof s.mcpTimeRange === "string" && /^[1-9]\d*[smhdw]$/.test(s.mcpTimeRange))) &&
    (s.mcpLimit === undefined || (Number.isSafeInteger(s.mcpLimit) && Number(s.mcpLimit) > 0));
}

export async function loadConfig(configPath: string): Promise<{ config: HarnessConfig; root: string }> {
  const source = JSON.parse(await readFile(configPath, 'utf8')) as unknown;
  if (!isRecord(source) || !isRecord(source.servers) || !Array.isArray(source.scenarios) ||
    !source.scenarios.every(validScenario)) {
    throw new Error('Invalid configuration or scenario schema');
  }
  if (typeof source.servers.reference !== 'string' || typeof source.servers.candidate !== 'string' ||
      typeof source.outputDir !== 'string' || !source.outputDir ||
      !Number.isSafeInteger(source.rpcTimeoutMs) || Number(source.rpcTimeoutMs) < 1000 ||
      !Number.isSafeInteger(source.retryCount) || Number(source.retryCount) < 0 || Number(source.retryCount) > 3) {
    throw new Error('Invalid servers, outputDir, rpcTimeoutMs, or retryCount');
  }
  if(source.replayPolicy!==undefined && !['FIXED_WINDOW','PERIOD_PAIRED'].includes(String(source.replayPolicy)))
    throw new Error('Invalid replayPolicy; expected FIXED_WINDOW or PERIOD_PAIRED');
  const ids = new Set(source.scenarios.map(s => (s as Scenario).id));
  if (ids.size !== source.scenarios.length) throw new Error('Duplicate scenario id');
  const root = resolve(dirname(configPath), '..');
  const outputDir = isAbsolute(source.outputDir) ? source.outputDir : resolve(root, source.outputDir);
  const serverEntry = (value: string) => isAbsolute(value) ? value : resolve(root, value);
  return {
    config: {
      ...source,
      servers: {
        reference: serverEntry(source.servers.reference),
        candidate: serverEntry(source.servers.candidate),
      },
      outputDir,
      scenarios: source.scenarios as Scenario[],
    } as HarnessConfig,
    root,
  };
}
