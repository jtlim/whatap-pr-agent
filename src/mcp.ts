import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { dirname } from 'node:path';
import type { McpTool, McpToolResult, RpcResponse } from './types.js';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Narrow JSON-RPC stdio adapter for read-only tools/list and tools/call.
 * No SDK needed for this phase. Later versions can replace this transport with
 * the official MCP client SDK without changing the validation logic.
 * No output size cap: entire JSON-RPC messages are parsed, including >1 MB.
 */
export class StdioMcpClient {
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private stderrTail = '';
  private failure?: Error;

  constructor(private readonly entry: string, private readonly timeoutMs: number) {}

  private dead(error: Error): void {
    if (!this.failure) this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.failure);
    }
    this.pending.clear();
  }

  private receive(message: RpcResponse): void {
    if (typeof message.id !== 'number') return; // notification / other server request
    const p = this.pending.get(message.id);
    if (!p) return;
    this.pending.delete(message.id);
    clearTimeout(p.timer);
    if (message.error) p.reject(new Error(`MCP RPC ${message.error.code}: ${message.error.message}`));
    else p.resolve(message.result);
  }

  private onData(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    while (true) {
      const i = this.buffer.indexOf('\n');
      if (i < 0) break;
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      try { this.receive(JSON.parse(line) as RpcResponse); }
      catch { this.dead(new Error('Malformed MCP JSON-RPC response on stdout')); return; }
    }
  }

  async start(): Promise<void> {
    if (this.child) throw new Error('MCP client already started');
    this.child = spawn(process.execPath, [this.entry], {
      cwd: dirname(this.entry),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (value: string) => { this.stderrTail = (this.stderrTail + value).slice(-8192); });
    this.child.on('error', (error: Error) => this.dead(error));
    this.child.stdin.on('error', (error: Error) => this.dead(error));
    this.child.on('exit', (code, signal) => {
      this.dead(new Error(`MCP process terminated (exit=${code}, signal=${signal})`));
    });
    const result = await this.call('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'whatap-validation-harness', version: '0.3.0' },
    }) as { protocolVersion?: string };
    if (!result || !result.protocolVersion) throw new Error('MCP initialize missing protocolVersion');
    this.notify('notifications/initialized');
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (!this.child || this.failure) throw this.failure ?? new Error('MCP client not running');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n');
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.child || this.failure) return Promise.reject(this.failure ?? new Error('MCP client not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const message = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      this.child!.stdin.write(message, err => {
        if (err) {
          const entry = this.pending.get(id);
          if (entry) { clearTimeout(entry.timer); this.pending.delete(id); reject(err); }
        }
      });
    });
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const result = await this.call('tools/list', cursor ? { cursor } : {}) as
        { tools?: McpTool[]; nextCursor?: string };
      if (!result || !Array.isArray(result.tools)) throw new Error('tools/list returned no tools array');
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (cursor) {
        if (seen.size >= 100 || seen.has(cursor)) throw new Error('MCP tools/list pagination loop');
        seen.add(cursor);
      }
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = await this.call('tools/call', { name, arguments: args });
    if (!result || typeof result !== 'object') throw new Error(`Invalid tools/call result for ${name}`);
    return result as McpToolResult;
  }

  stderrHint(): string { return this.stderrTail; }

  async close(): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    this.child = undefined;
    this.dead(new Error('MCP client closed'));
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    if (child.exitCode !== null || child.signalCode !== null) return;
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    timer.unref();
    child.once('exit', () => clearTimeout(timer));
    child.kill('SIGTERM');
  }
}
