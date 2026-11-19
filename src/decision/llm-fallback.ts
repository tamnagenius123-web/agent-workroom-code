// Chat fallback used by decide() when a decision-model call does not land.
// The shared or-harness client in this repo stays fail-closed. These helpers are the
// calls decide() already makes: a roster estimate, one chat POST, and a generation-cost GET.
// They do not reserve, settle, or dispatch.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROSTER_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../config/models.openrouter.json');
const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GENERATION_URL = 'https://openrouter.ai/api/v1/generation';
const MIN_HEADROOM_MICRO = 200;

export interface RosterModel {
  id: string;
  price_usd_per_token: { prompt: string; completion: string };
}

export interface Roster {
  models: RosterModel[];
}

export interface ChatUsage {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
}

export interface GenerationTokens {
  prompt: number | null;
  completion: number | null;
  total: number | null;
}

export interface GenerationCost {
  micro_usd: number;
  cost_field: 'total_cost' | 'usage';
  provider_name: string | null;
  model: string | null;
  tokens: GenerationTokens;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class OpenRouterError extends Error {
  readonly reason: string;
  readonly status: number | null;
  readonly generation_id: string | null;
  readonly retryable: boolean;
  readonly text: string;
  readonly usage: ChatUsage | null;

  constructor(reason: string, options: {
    status?: number | null;
    generation_id?: string | null;
    retryable: boolean;
    text?: string;
    usage?: ChatUsage | null;
  }) {
    super(reason);
    this.name = 'OpenRouterError';
    this.reason = reason;
    this.status = options.status ?? null;
    this.generation_id = options.generation_id ?? null;
    this.retryable = options.retryable;
    this.text = options.text ?? '';
    this.usage = options.usage ?? null;
  }
}

let rosterCache: { path: string; roster: Roster } | null = null;

export function loadRoster(path = ROSTER_PATH): Roster {
  if (rosterCache?.path === path) return rosterCache.roster;
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Roster).models)) {
    throw new Error('invalid roster');
  }
  const roster = parsed as Roster;
  rosterCache = { path, roster };
  return roster;
}

function requireModel(model: string, roster = loadRoster()): RosterModel {
  const row = roster.models.find(item => item.id === model);
  if (!row) throw new Error(`model not in roster: ${model}`);
  return row;
}

function usdPerTokenToNano(price: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(price)) throw new Error('invalid token price');
  const parts = price.split('.');
  const whole = parts[0] ?? '0';
  const frac = parts[1] ?? '';
  return BigInt(whole) * 1_000_000_000n + BigInt((frac + '000000000').slice(0, 9));
}

function promptTokenEstimate(promptChars: number): number {
  if (!Number.isSafeInteger(promptChars) || promptChars < 0) throw new Error('promptChars must be a non-negative integer');
  return Math.ceil(promptChars / 3) + 16;
}

export function estimateMicroUsd(model: string, promptChars: number, maxTokens: number, roster?: Roster): number {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 0) throw new Error('maxTokens must be a non-negative integer');
  const row = requireModel(model, roster);
  const prompt = row.price_usd_per_token?.prompt;
  const completion = row.price_usd_per_token?.completion;
  if (typeof prompt !== 'string' || typeof completion !== 'string') throw new Error(`model missing per-token price: ${model}`);
  const promptTokens = promptTokenEstimate(promptChars);
  const nano = BigInt(promptTokens) * usdPerTokenToNano(prompt) + BigInt(maxTokens) * usdPerTokenToNano(completion);
  const micro = (nano + 999n) / 1_000n;
  if (micro > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('estimate overflow');
  return Number(micro);
}

/** Hold is ceil(estimate × 1.5), and at least estimate + 200 micro-USD. */
export function reservationMicroUsd(estimate: number): number {
  if (!Number.isSafeInteger(estimate) || estimate < 0) throw new Error('bad estimate');
  const est = BigInt(estimate);
  const times15 = (est * 3n + 1n) / 2n;
  const plusMin = est + BigInt(MIN_HEADROOM_MICRO);
  const hold = times15 > plusMin ? times15 : plusMin;
  return Number(hold);
}

export function roundUsdToMicro(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) throw new OpenRouterError('bad_cost', { retryable: false });
  const micro = Math.round(usd * 1_000_000);
  if (!Number.isSafeInteger(micro)) throw new OpenRouterError('bad_cost', { retryable: false });
  return micro;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function usageOf(body: unknown): ChatUsage {
  const raw = body && typeof body === 'object' ? (body as { usage?: unknown }).usage : null;
  if (!raw || typeof raw !== 'object') return { prompt_tokens: null, completion_tokens: null, total_tokens: null };
  const usage = raw as Record<string, unknown>;
  return {
    prompt_tokens: asNumber(usage.prompt_tokens),
    completion_tokens: asNumber(usage.completion_tokens),
    total_tokens: asNumber(usage.total_tokens),
  };
}

function textOf(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0];
  if (!first || typeof first !== 'object') return '';
  const message = (first as { message?: unknown }).message;
  const content = message && typeof message === 'object' ? (message as { content?: unknown }).content : (first as { text?: unknown }).text;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') parts.push(part);
    else if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') parts.push((part as { text: string }).text);
  }
  return parts.join('');
}

function generationIdOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const top = (body as { id?: unknown }).id;
  if (typeof top === 'string' && top.length > 0) return top;
  const data = (body as { data?: unknown }).data;
  if (data && typeof data === 'object') {
    const nested = (data as { id?: unknown }).id;
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }
  return null;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function authHeaders(apiKey: string, jsonBody: boolean): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
  if (jsonBody) headers['Content-Type'] = 'application/json';
  return headers;
}

function usableKey(apiKey: string | undefined): string | null {
  if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.trim() !== apiKey) return null;
  if (/[\r\n\0]/.test(apiKey)) return null;
  return apiKey;
}

export async function chatOnce(input: {
  model: string;
  prompt: string;
  maxTokens: number;
  timeoutMs: number;
  fetchImpl: FetchLike;
  apiKey: string;
}): Promise<{ generation_id: string; text: string; usage: ChatUsage }> {
  const key = usableKey(input.apiKey);
  if (!key) throw new OpenRouterError('missing_api_key', { retryable: false });
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) throw new OpenRouterError('bad_timeout', { retryable: false });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    let response: Response;
    let body: unknown;
    try {
      response = await input.fetchImpl(CHAT_URL, {
        method: 'POST',
        headers: authHeaders(key, true),
        body: JSON.stringify({
          model: input.model,
          messages: [{ role: 'user', content: input.prompt }],
          max_tokens: input.maxTokens,
        }),
        signal: controller.signal,
      });
      body = await readJson(response);
    } catch (error) {
      if (isAbort(error)) throw new OpenRouterError('timeout', { retryable: false });
      throw new OpenRouterError('transport', { retryable: false });
    }
    const generation_id = generationIdOf(body);
    const text = textOf(body);
    const usage = usageOf(body);
    if (!response.ok) {
      throw new OpenRouterError(`http_${response.status}`, {
        status: response.status,
        generation_id,
        retryable: false,
        text,
        usage,
      });
    }
    if (!generation_id) throw new OpenRouterError('no_generation_id', { status: response.status, retryable: false, text, usage });
    return { generation_id, text, usage };
  } finally {
    clearTimeout(timer);
  }
}

function generationRecord(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const outer = body as Record<string, unknown>;
  const data = outer.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  return outer;
}

function presentUsd(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return Number.NaN;
}

function tokensOf(record: Record<string, unknown>): GenerationTokens {
  const prompt = asNumber(record.tokens_prompt);
  const completion = asNumber(record.tokens_completion);
  return { prompt, completion, total: prompt !== null && completion !== null ? prompt + completion : null };
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

export async function getGenerationCost(id: string, options: {
  fetchImpl: FetchLike;
  apiKey: string;
  retries?: number;
  delayMs?: number;
  timeoutMs?: number;
}): Promise<GenerationCost | null> {
  const key = usableKey(options.apiKey);
  if (!key) throw new OpenRouterError('missing_api_key', { retryable: false });
  if (!id) throw new OpenRouterError('missing_generation_id', { retryable: false });
  const attempts = options.retries ?? 10;
  const delayMs = options.delayMs ?? 2_000;
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isInteger(attempts) || attempts < 1) throw new OpenRouterError('bad_retries', { retryable: false });
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new OpenRouterError('bad_delay', { retryable: false });
  const url = `${GENERATION_URL}?id=${encodeURIComponent(id)}`;
  let sawMissing = false;
  let lastError: OpenRouterError | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await options.fetchImpl(url, { method: 'GET', headers: authHeaders(key, false), signal: controller.signal });
      } catch (error) {
        lastError = isAbort(error) ? new OpenRouterError('timeout', { retryable: true }) : new OpenRouterError('transport', { retryable: true });
        if (attempt < attempts) { await sleep(delayMs); continue; }
        break;
      }
      const body = await readJson(response);
      if (response.status === 404 || response.status === 204) {
        sawMissing = true;
        if (attempt < attempts) { await sleep(delayMs); continue; }
        break;
      }
      if (response.status >= 400 && response.status < 500) {
        throw new OpenRouterError(`http_${response.status}`, { status: response.status, retryable: false });
      }
      if (!response.ok) {
        lastError = new OpenRouterError(`http_${response.status}`, { status: response.status, retryable: true });
        if (attempt < attempts) { await sleep(delayMs); continue; }
        break;
      }
      const record = generationRecord(body);
      const total = record ? presentUsd(record.total_cost) : undefined;
      const usage = record ? presentUsd(record.usage) : undefined;
      if (total === undefined && usage === undefined) {
        sawMissing = true;
        if (attempt < attempts) { await sleep(delayMs); continue; }
        break;
      }
      const chosen = total !== undefined ? { usd: total, cost_field: 'total_cost' as const } : { usd: usage as number, cost_field: 'usage' as const };
      if (!Number.isFinite(chosen.usd) || chosen.usd < 0) throw new OpenRouterError('bad_cost', { retryable: false });
      return {
        micro_usd: roundUsdToMicro(chosen.usd),
        cost_field: chosen.cost_field,
        provider_name: record && typeof record.provider_name === 'string' && record.provider_name ? record.provider_name : null,
        model: record && typeof record.model === 'string' && record.model ? record.model : null,
        tokens: record ? tokensOf(record) : { prompt: null, completion: null, total: null },
      };
    } finally {
      clearTimeout(timer);
    }
  }
  if (sawMissing) return null;
  throw lastError ?? new OpenRouterError('cost_lookup_failed', { retryable: false });
}
