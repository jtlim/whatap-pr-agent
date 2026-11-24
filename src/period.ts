import type { JsonRow } from './validator.js';

/** The candidate WhaTap MCP currently renders its Period and `time` column at whole-second precision. */
export interface FormattedMcpData {
  period: { label: string; stime: number; etime: number };
  rows: JsonRow[];
  columns: string[];
  truncated: boolean;
}

const UTC_TIME = '(\\d{4}-\\d{2}-\\d{2})[ T](\\d{2}:\\d{2}:\\d{2}) UTC';
const PERIOD_RE = new RegExp('\\*\\*Period\\*\\*:\\s*' + UTC_TIME + '\\s*(?:→|->|to)\\s*' + UTC_TIME, 'i');
const CELL_TIME_RE = new RegExp('^' + UTC_TIME + '$');

function utcMillis(date: string, time: string): number | null {
  const d = Date.parse(`${date}T${time}Z`);
  if (!Number.isFinite(d) || new Date(d).toISOString().slice(0, 19) !== `${date}T${time}`) return null;
  return d;
}

export function parseMcpPeriod(text: string): FormattedMcpData['period'] | null {
  const m = PERIOD_RE.exec(text);
  if (!m) return null;
  const stime = utcMillis(m[1], m[2]), etime = utcMillis(m[3], m[4]);
  if (stime === null || etime === null || etime <= stime) return null;
  return { label: m[0], stime, etime };
}

function splitCells(line: string): string[] {
  if (!/^\s*\|/.test(line) || !/\|\s*$/.test(line)) return [];
  return line.trim().slice(1, -1).split(/(?<!\\)\|/).map(v => v.trim().replace(/\\\|/g, '|'));
}
function unwrapHeader(c: string): string {
  return c.replace(/\s+\((?:%|ms|bytes)\)$/i, '').replace(/`/g, '');
}
function decodeCell(raw: string, column: string): unknown {
  if (column === 'time') {
    const m = CELL_TIME_RE.exec(raw);
    if (m) return utcMillis(m[1], m[2]);
    if (/^\d{13}$/.test(raw)) return Number(raw);
    return raw; // explicitly fail later if the timestamp is not interpretable
  }
  // '-' may represent null or a literal dash: compare what the MCP visibly prints.
  return raw; // identity and values are normalized by compareRows, not by parser
}

/**
 * Strictly parse the *data table* of whatap_query_data; never treat summaries/guide tables as data.
 * Reject ambiguous tables, missing keys, partially parsed rows and repeated headers.
 */
export function parseFormattedMcp(text: string, required: string[]):
  { ok: true; data: FormattedMcpData } | { ok: false; reason: string } {
  const period = parseMcpPeriod(text);
  if (!period) return { ok: false, reason: 'MCP_PERIOD_MISSING_OR_INVALID' };
  const lines = text.split(/\r?\n/);
  const candidates: Array<{ index: number; columns: string[] }> = [];
  for (let i=0; i<lines.length-1; i++) {
    const cols = splitCells(lines[i]).map(unwrapHeader);
    if (!cols.includes('time') || !required.every(k=>cols.includes(k))) continue;
    const sep = splitCells(lines[i+1]);
    if (sep.length !== cols.length || !sep.every(v=>/^:?-{3,}:?$/.test(v))) continue;
    candidates.push({index:i, columns:cols});
  }
  if (candidates.length !== 1) return {ok:false,reason:'MCP_DATA_TABLE_MISSING_OR_AMBIGUOUS'};
  const {index,columns} = candidates[0];
  if (new Set(columns).size !== columns.length) return {ok:false,reason:'MCP_DUPLICATED_TABLE_COLUMNS'};
  const rows: JsonRow[] = [];
  for (let i=index+2; i<lines.length; i++) {
    if (!/^\s*\|/.test(lines[i])) break;
    const cells = splitCells(lines[i]);
    if (cells.length !== columns.length) return {ok:false,reason:'MCP_TABLE_ROW_WIDTH_INVALID'};
    const row: JsonRow = {};
    for (let j=0;j<columns.length;j++) row[columns[j]] = decodeCell(cells[j], columns[j]);
    if (typeof row.time !== 'number' || !Number.isSafeInteger(row.time)) return {ok:false,reason:'MCP_TABLE_TIMESTAMP_INVALID'};
    rows.push(row);
  }
  if (!rows.length) return {ok:false,reason:'MCP_TABLE_NO_ROWS'};
  const truncated = /Result may be truncated|Showing\s+\d+\s+rows[^\n]*truncated|result may be truncated/i.test(text);
  return {ok:true,data:{period,rows,columns,truncated}};
}

/** When a value is displayed by formatValue(), non-integers are rounded to two decimals. */
export function forMcpDisplay(reference: JsonRow[], fields: string[]): JsonRow[] {
  return reference.map(row => {
    const result = { ...row };
    for (const field of fields) {
      const value = row[field];
      if (value === null) result[field] = '-';
      else if (typeof value === 'number' && !Number.isInteger(value)) result[field] = Number(value.toFixed(2));
    }
    return result;
  });
}

export function expectedDurationMs(expr: string): number | null {
  const m = /^(\d+)\s*([smhdw])$/.exec(expr);
  if (!m) return null;
  return Number(m[1]) * ({s:1000,m:60000,h:3600000,d:86400000,w:604800000}[m[2]] ?? 0);
}
