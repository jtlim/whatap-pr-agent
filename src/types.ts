export type Status = 'PASS' | 'FAIL' | 'UNVERIFIABLE' | 'UNMAPPED' | 'UNSUPPORTED';
export type Domain = 'server' | 'apm' | 'timeseries';

export interface Scenario {
  id: string;
  domain: Domain;
  description: string;
  projectCode: number;
  stime: number;
  etime: number;
  referenceTool: string;
  /** null means no established equivalent MCP query. */
  mcpPath: string | null;
  /** Expected semantic mapping, not passed to the LLM. */
  allowedMcpPaths?: string[];
  /** Natural-language question; the agent chooses tools, filters and limit. */
  userRequest?: string;
  /** Expected user-request duration, only checked after the LLM calls MCP; never injected. */
  expectedDuration?: string;
  matchKeys?: string[];
  compareFields?: string[];
  absoluteTolerance?: number;
  expectedStepMs?: number;
  /** Cross-API 5-minute APM statistics mode, with a same-MXQL transport check. */
  statisticsMode?: 'transaction' | 'exception';
  /** Relative range passed to the existing MCP (e.g. 5m). Null means reference-only. */
  mcpTimeRange?: string;
  /** Maximum rows requested from MCP, not a cap imposed by the HTTP reference. */
  mcpLimit?: number;
}

export interface HarnessConfig {
  servers: { reference: string; candidate: string };
  rpcTimeoutMs: number;
  retryCount: number;
  outputDir: string;
  /** FIXED_WINDOW is the original F1-B policy. PERIOD_PAIRED preserves the relative-only MCP contract. */
  replayPolicy?: 'FIXED_WINDOW'|'PERIOD_PAIRED';
  scenarios: Scenario[];
}

export interface Check {
  code: string;
  ok: boolean;
  detail: string;
}

/** One observed MCP tools/call and its independently verified HTTP reference. */
export interface CallReport {
  index: number;
  status: Status;
  reason: string;
  mcpTool: string | null;
  mcpPath: string | null;
  timeWindow: ScenarioReport['timeWindow'];
  checks: Check[];
  reference: ScenarioReport['reference'];
  candidate: ScenarioReport['candidate'];
}

export interface ScenarioReport {
  id: string;
  domain: Domain;
  projectCode: number;
  timeWindow: { stime: number; etime: number };
  referenceTool: string;
  mcpTool: string | null;
  mcpPath: string | null;
  status: Status;
  reason: string;
  checks: Check[];
  /** Present when Codex makes multiple applicable MCP calls. All are verified. */
  callResults?: CallReport[];
  reference: {
    httpStatus?: number;
    apiPath?: string;
    rowCount?: number;
    total?: number;
    retrievedTotal?: number;
    /** Original and retry evidence for a strictly proven one-bucket boundary shift. */
    statistics?: {
      mxql: {file:string;sha256:string;httpStatus?:number;rowCount?:number};
      v2Window: {stime:number;etime:number};
      v2RowCount?:number;
      comparedBuckets?:number;
      visibleMcpRows?:number;
      fullMxqlRows?:number;
    };
    boundaryAlignment?: {
      original: {file:string;sha256:string;timeWindow:{stime:number;etime:number};httpStatus?:number;rowCount?:number};
      attempts: Array<{deltaMs:number;timeWindow:{stime:number;etime:number};file:string;sha256:string;status:Status;reason:string}>;
      selectedDeltaMs?:number;
    };
    file?: string;
    sha256?: string;
    error?: string;
  };
  candidate: {
    args?: Record<string, unknown>;
    file?: string;
    sha256?: string;
    error?: string;
    evidence?: string;
    period?: string;
    parsedRows?: number;
    requestedLimit?: number;
    comparisonPrecision?: string;
  };
}

export interface RunReport {
  /** F1-B: replay observation recorded by Harness direct MCP client (not an LLM claim). */
  fixedReplayAudit?: {mode:"DIRECT_MCP_TOOL_CALL"; originalArgs:Record<string,unknown>; replayArgs:Record<string,unknown>;
    requestedWindow:{stime:number;etime:number}; schemaVerdict:string; toolCalls:number; periodMatched:boolean};
  /** F2: exact original relative arguments, candidate-reported Period independently checked over HTTP. */
  relativeReplayAudit?: {mode:'DIRECT_RELATIVE_MCP_CALL';originalArgs:Record<string,unknown>;replayArgs:Record<string,unknown>;
    toolCalls:number;schemaVerified:boolean;periodObserved:boolean;observedWindow:{stime:number;etime:number}|null};
  harnessVersion: string;
  startedAt: string;
  finishedAt: string;
  runDir: string;
  mode: 'observe-only';
  sourceModified: false;
  scenarios: ScenarioReport[];
  totals: Record<Status, number>;
  notes: string[];
}

export interface RpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: unknown;
}

export interface McpTool { name: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] }; description?: string }
export interface McpToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}
