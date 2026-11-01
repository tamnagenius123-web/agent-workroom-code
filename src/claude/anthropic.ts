// Claude platform helpers: prompt caching, usage metering, Message Batches, MCP connector,
// optional Admin usage API. Pure builders plus thin fetch wrappers; keys are never logged.
// fetchFn is injected so tests run offline.

import type { ContextPack } from '../server/context-pack.ts';
import type { FoldContextPack } from '../server/fold-pack.ts';
import type { RoomBrief } from '../server/room-brief.ts';

export const API_BASE = 'https://api.anthropic.com';
export const API_VERSION = '2023-06-01';
export const MCP_CONNECTOR_BETA = 'mcp-client-2025-04-04';
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface StableBaseline {
  room_brief?: RoomBrief;
  context_pack?: ContextPack;
  fold_pack?: FoldContextPack;
}

export interface TextBlock { type: 'text'; text: string; cache_control?: { type: 'ephemeral'; ttl?: '5m' | '1h' } }

/** Deterministic JSON (sorted keys) so the cached prefix is byte-identical across calls. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v;
  });
}

/** System blocks: the stable baseline last, carrying the single cache breakpoint. */
export function cachedSystem(instructions: string, baseline: StableBaseline, ttl: '5m' | '1h' = '5m'): TextBlock[] {
  const parts: [string, unknown][] = [['room_brief', baseline.room_brief], ['context_pack', baseline.context_pack], ['fold_pack', baseline.fold_pack]];
  const body = parts.filter(([, v]) => v !== undefined).map(([k, v]) => `<${k}>\n${stableJson(v)}\n</${k}>`).join('\n');
  const blocks: TextBlock[] = [{ type: 'text', text: instructions }];
  if (body) blocks.push({ type: 'text', text: body, cache_control: ttl === '5m' ? { type: 'ephemeral' } : { type: 'ephemeral', ttl } });
  return blocks;
}

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export function readUsage(raw: unknown): ClaudeUsage {
  const u = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const n = (k: string): number => (typeof u[k] === 'number' && Number.isFinite(u[k]) ? u[k] as number : 0);
  return { input_tokens: n('input_tokens'), output_tokens: n('output_tokens'), cache_creation_input_tokens: n('cache_creation_input_tokens'), cache_read_input_tokens: n('cache_read_input_tokens') };
}

/** USD per million tokens. Callers supply rates; unknown model -> undefined (never a guessed 0). */
export interface Rates { input: number; output: number }
export function costUsdMicros(u: ClaudeUsage, r: Rates | undefined, opts: { ttl?: '5m' | '1h'; batch?: boolean } = {}): number | undefined {
  if (!r) return undefined;
  const write = opts.ttl === '1h' ? 2 : 1.25;
  const usd = (u.input_tokens * r.input + u.cache_creation_input_tokens * r.input * write + u.cache_read_input_tokens * r.input * 0.1 + u.output_tokens * r.output);
  return Math.round(usd * (opts.batch ? 0.5 : 1)); // tokens * $/Mtok == micro-USD
}

function headers(key: string, beta?: string): Record<string, string> {
  const h: Record<string, string> = { 'x-api-key': key, 'anthropic-version': API_VERSION, 'content-type': 'application/json' };
  if (beta) h['anthropic-beta'] = beta;
  return h;
}

async function call(fetchFn: FetchFn, key: string, path: string, method: string, body?: unknown, beta?: string): Promise<unknown> {
  const res = await fetchFn(`${API_BASE}${path}`, { method, headers: headers(key, beta), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`anthropic ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text.startsWith('{') ? JSON.parse(text) : text;
}

export function createMessage(fetchFn: FetchFn, key: string, body: Record<string, unknown>, beta?: string): Promise<unknown> {
  return call(fetchFn, key, '/v1/messages', 'POST', body, beta);
}

// ---- MCP connector ----
export interface McpServerRef { url: string; name: string; authorization_token?: string; allowed_tools?: string[] }
export function withMcpConnector(body: Record<string, unknown>, server: McpServerRef): { body: Record<string, unknown>; beta: string } {
  if (!/^https:\/\//.test(server.url)) throw new Error('MCP connector requires a public https URL');
  const entry: Record<string, unknown> = { type: 'url', url: server.url, name: server.name };
  if (server.authorization_token) entry.authorization_token = server.authorization_token;
  if (server.allowed_tools) entry.tool_configuration = { enabled: true, allowed_tools: server.allowed_tools };
  return { body: { ...body, mcp_servers: [entry] }, beta: MCP_CONNECTOR_BETA };
}

// ---- Message Batches ----
export interface BatchRequest { custom_id: string; params: Record<string, unknown> }
export interface BatchResult { custom_id: string; type: string; text?: string; usage?: ClaudeUsage; error?: unknown }

export function createBatch(fetchFn: FetchFn, key: string, requests: BatchRequest[]): Promise<unknown> {
  if (requests.length === 0) throw new Error('empty batch');
  const ids = new Set(requests.map(r => r.custom_id));
  if (ids.size !== requests.length) throw new Error('duplicate custom_id');
  return call(fetchFn, key, '/v1/messages/batches', 'POST', { requests });
}
export function getBatch(fetchFn: FetchFn, key: string, id: string): Promise<unknown> {
  return call(fetchFn, key, `/v1/messages/batches/${encodeURIComponent(id)}`, 'GET');
}
export function parseBatchResults(jsonl: string): BatchResult[] {
  return jsonl.split('\n').filter(l => l.trim()).map(l => {
    const row = JSON.parse(l) as { custom_id: string; result: { type: string; message?: { content?: { type: string; text?: string }[]; usage?: unknown }; error?: unknown } };
    const msg = row.result.message;
    return { custom_id: row.custom_id, type: row.result.type, text: msg?.content?.filter(c => c.type === 'text').map(c => c.text).join(''), usage: msg ? readUsage(msg.usage) : undefined, error: row.result.error };
  });
}
export async function batchResults(fetchFn: FetchFn, key: string, resultsUrl: string): Promise<BatchResult[]> {
  const res = await fetchFn(resultsUrl, { method: 'GET', headers: headers(key) });
  if (!res.ok) throw new Error(`batch results -> ${res.status}`);
  return parseBatchResults(await res.text());
}

// ---- Admin usage (optional) ----
export type AdminUsage = { available: false; reason: string } | { available: true; data: unknown };
export async function adminUsageReport(fetchFn: FetchFn, adminKey: string | undefined, startingAt: string): Promise<AdminUsage> {
  if (!adminKey) return { available: false, reason: 'ANTHROPIC_ADMIN_KEY not set' };
  if (!adminKey.startsWith('sk-ant-admin')) return { available: false, reason: 'not an admin key' };
  try {
    return { available: true, data: await call(fetchFn, adminKey, `/v1/organizations/usage_report/messages?starting_at=${encodeURIComponent(startingAt)}`, 'GET') };
  } catch (e) {
    return { available: false, reason: e instanceof Error ? e.message.replace(/sk-ant-[\w-]+/g, '[redacted]') : 'error' };
  }
}
