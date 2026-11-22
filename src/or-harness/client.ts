// Port of agent-workroom-gate-mcp src/or-harness/client.ts @ 81370fb8fe0d080af3946fbf15fe953ee93b5893.
// This is the one dispatch provider the product worker bundles. The roster is the
// bundled JSON import. An unset API key throws before reserve and before fetch.
// The decision-layer chatOnce helper is separate and is not this provider.
import { createHash } from 'node:crypto';
import rosterJson from '../../config/models.openrouter.json' with { type: 'json' };

export const BUNDLED_ROSTER_PATH = 'config/models.openrouter.json';
const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GENERATION_URL = 'https://openrouter.ai/api/v1/generation';

export const DEFAULT_CHAT_TIMEOUT_MS = 60_000;
export const DEFAULT_COST_RETRIES = 10;
export const DEFAULT_COST_DELAY_MS = 2_000;
/** No automatic chat POST retries: a lost response can hide provider acceptance. */
export const CHAT_TRANSPORT_RETRIES = 0;
const MIN_HEADROOM_MICRO = 200;

export interface RosterModel {
  requested: string;
  id: string;
  tier: string;
  context_length: number;
  price_usd_per_token: { prompt: string; completion: string };
  price_usd_per_mtok: { prompt: number; completion: number };
  max_completion_tokens: number;
  role_hints: string;
  mapping_note?: string;
  alt_ids?: string[];
}

export interface Roster {
  version: number;
  snapshot_utc: string;
  source: string;
  project_defaults: Record<string, { cap_usd: number }>;
  models: RosterModel[];
}

export interface PricingSnapshot {
  model: string;
  snapshot_utc: string;
  source: string;
  price_usd_per_token: { prompt: string; completion: string };
  prompt_chars: number;
  prompt_tokens_est: number;
  max_tokens: number;
  estimate_micro_usd: number;
  reserved_micro_usd: number;
}

export interface ReserveInput {
  project: string;
  run_id: string;
  attempt_id: string;
  model: string;
  est_micro_usd: number;
  pricing_snapshot: PricingSnapshot;
}

export type ReserveResult = { ok: true; reservation_id: string } | { ok: false; reason: string; remaining: number };

export interface GenerationTokens {
  prompt: number | null;
  completion: number | null;
  total: number | null;
}

export interface SettleInput {
  generation_id: string;
  micro_usd: number;
  cost_field: 'total_cost' | 'usage';
  provider_account: string | null;
  model: string;
  tokens: GenerationTokens;
}

export interface PendingMark {
  generation_id?: string;
  provider_account?: string | null;
  model?: string;
}

export interface Ledger {
  reserve(input: ReserveInput): ReserveResult | Promise<ReserveResult>;
  markPending(reservation_id: string, reason: string, extra?: PendingMark): void | Promise<void>;
  settle(reservation_id: string, actual: SettleInput): void | Promise<void>;
  summary(project: string): unknown | Promise<unknown>;
}

export interface ChatUsage {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
}

export interface GenerationCost {
  micro_usd: number;
  cost_field: 'total_cost' | 'usage';
  provider_name: string | null;
  model: string | null;
  tokens: GenerationTokens;
}

export interface DispatchReport {
  model: string;
  generation_id: string | null;
  state: 'settled' | 'pending_actual' | 'denied' | 'dry_run';
  micro_usd: number | null;
  text: string;
  summary: unknown;
  reason: string | null;
  run_id: string;
  attempt_id: string;
  reservation_id: string | null;
  estimate_micro_usd: number;
  reserve_micro_usd: number;
  remaining: number | null;
  cost_field: 'total_cost' | 'usage' | null;
  reservation_ok: boolean | null;
  usage: ChatUsage | null;
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

function parseRoster(parsed: unknown): Roster {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Roster).models)) {
    throw new Error('invalid roster');
  }
  return parsed as Roster;
}

const bundledRoster = parseRoster(rosterJson);

export function loadRoster(path = BUNDLED_ROSTER_PATH): Roster {
  if (path !== BUNDLED_ROSTER_PATH) throw new Error('roster path is not bundled');
  return bundledRoster;
}

function findModel(roster: Roster, model: string): RosterModel | undefined {
  return roster.models.find(row => row.id === model);
}

function requireModel(model: string, roster = loadRoster()): RosterModel {
  const row = findModel(roster, model);
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

export function reservationMicroUsd(estimate: number): number {
  if (!Number.isSafeInteger(estimate) || estimate < 0) throw new Error('bad estimate');
  const est = BigInt(estimate);
  const times15 = (est * 3n + 1n) / 2n;
  const plusMin = est + BigInt(MIN_HEADROOM_MICRO);
  const hold = times15 > plusMin ? times15 : plusMin;
  return Number(hold);
}

export function defaultIds(model: string, project: string, prompt: string): { run_id: string; attempt_id: string } {
  const hex = createHash('sha256').update(`${model}|${project}|${prompt}`).digest('hex').slice(0, 12);
  const run_id = `run-${hex}`;
  return { run_id, attempt_id: `${run_id}-a1` };
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
  const attempts = options.retries ?? DEFAULT_COST_RETRIES;
  const delayMs = options.delayMs ?? DEFAULT_COST_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
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

function remainingMicro(summary: unknown): number | null {
  if (!summary || typeof summary !== 'object') return null;
  const record = summary as Record<string, unknown>;
  for (const key of ['remaining_micro_usd', 'remaining']) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

async function settleOrPending(input: {
  ledger: Ledger;
  reservation_id: string;
  project: string;
  model: string;
  generation_id: string;
  text: string;
  usage: ChatUsage | null;
  run_id: string;
  attempt_id: string;
  estimate_micro_usd: number;
  reserve_micro_usd: number;
  fetchImpl: FetchLike;
  apiKey: string;
  costRetries: number;
  costDelayMs: number;
  timeoutMs: number;
}): Promise<DispatchReport> {
  const base = {
    model: input.model,
    generation_id: input.generation_id,
    text: input.text,
    run_id: input.run_id,
    attempt_id: input.attempt_id,
    reservation_id: input.reservation_id,
    estimate_micro_usd: input.estimate_micro_usd,
    reserve_micro_usd: input.reserve_micro_usd,
    usage: input.usage,
    remaining: null as number | null,
    reservation_ok: true as boolean | null,
  };
  const pendingMark: PendingMark = { generation_id: input.generation_id, model: input.model };
  let cost: GenerationCost | null;
  try {
    cost = await getGenerationCost(input.generation_id, {
      fetchImpl: input.fetchImpl,
      apiKey: input.apiKey,
      retries: input.costRetries,
      delayMs: input.costDelayMs,
      timeoutMs: input.timeoutMs,
    });
  } catch (error) {
    const reason = error instanceof OpenRouterError ? `cost_${error.reason}` : 'cost_transport';
    await input.ledger.markPending(input.reservation_id, reason, pendingMark);
    return { ...base, state: 'pending_actual', micro_usd: null, cost_field: null, reason, summary: await input.ledger.summary(input.project) };
  }
  if (!cost) {
    await input.ledger.markPending(input.reservation_id, 'cost_unknown', pendingMark);
    return { ...base, state: 'pending_actual', micro_usd: null, cost_field: null, reason: 'cost_unknown', summary: await input.ledger.summary(input.project) };
  }
  await input.ledger.settle(input.reservation_id, {
    generation_id: input.generation_id,
    micro_usd: cost.micro_usd,
    cost_field: cost.cost_field,
    provider_account: cost.provider_name,
    model: cost.model ?? input.model,
    tokens: cost.tokens,
  });
  return {
    ...base,
    state: 'settled',
    micro_usd: cost.micro_usd,
    cost_field: cost.cost_field,
    reason: null,
    summary: await input.ledger.summary(input.project),
  };
}

export interface PendingGenerationHold {
  reservation_id: string;
  generation_id: string;
  provider_account: string | null;
  model: string;
  project: string;
  state: 'pending_actual' | 'unknown';
}

export interface SettlePendingResult {
  reservation_id: string;
  generation_id: string;
  project: string;
  state: 'settled' | 'pending_actual' | 'unknown';
  micro_usd: number | null;
  cost_field: 'total_cost' | 'usage' | null;
  reason: string | null;
}

export interface SettlePendingReport {
  mode: 'settle-pending';
  checked: number;
  settled: number;
  still_pending: number;
  results: SettlePendingResult[];
}

export interface SettlePendingLedger {
  listPendingWithGeneration(): Promise<PendingGenerationHold[]> | PendingGenerationHold[];
  settle(reservation_id: string, actual: SettleInput): void | Promise<void>;
}

function generationOnlyFetch(fetchImpl: FetchLike): FetchLike {
  return async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const target = String(url);
    if (method !== 'GET' || !target.startsWith(GENERATION_URL)) {
      throw new OpenRouterError('settle_pending_chat_forbidden', { retryable: false });
    }
    return fetchImpl(url, init);
  };
}

function pendingResult(hold: PendingGenerationHold, reason: string): SettlePendingResult {
  return {
    reservation_id: hold.reservation_id,
    generation_id: hold.generation_id,
    project: hold.project,
    state: hold.state,
    micro_usd: null,
    cost_field: null,
    reason,
  };
}

export async function settlePending(input: {
  ledger: SettlePendingLedger;
  fetchImpl?: FetchLike;
  apiKey: string;
  costRetries?: number;
  costDelayMs?: number;
  timeoutMs?: number;
}): Promise<SettlePendingReport> {
  const key = usableKey(input.apiKey);
  if (!key) throw new OpenRouterError('missing_api_key', { retryable: false });
  const fetchImpl = generationOnlyFetch(input.fetchImpl ?? globalThis.fetch);
  const holds = await input.ledger.listPendingWithGeneration();
  const results: SettlePendingResult[] = [];
  for (const hold of holds) {
    let cost: GenerationCost | null;
    try {
      cost = await getGenerationCost(hold.generation_id, {
        fetchImpl,
        apiKey: key,
        retries: input.costRetries ?? DEFAULT_COST_RETRIES,
        delayMs: input.costDelayMs ?? DEFAULT_COST_DELAY_MS,
        timeoutMs: input.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof OpenRouterError && error.reason === 'settle_pending_chat_forbidden') throw error;
      const reason = error instanceof OpenRouterError ? `cost_${error.reason}` : 'cost_transport';
      results.push(pendingResult(hold, reason));
      continue;
    }
    if (!cost) {
      results.push(pendingResult(hold, 'cost_unknown'));
      continue;
    }
    await input.ledger.settle(hold.reservation_id, {
      generation_id: hold.generation_id,
      micro_usd: cost.micro_usd,
      cost_field: cost.cost_field,
      provider_account: cost.provider_name ?? hold.provider_account,
      model: cost.model ?? hold.model,
      tokens: cost.tokens,
    });
    results.push({
      reservation_id: hold.reservation_id,
      generation_id: hold.generation_id,
      project: hold.project,
      state: 'settled',
      micro_usd: cost.micro_usd,
      cost_field: cost.cost_field,
      reason: null,
    });
  }
  const settled = results.filter(row => row.state === 'settled').length;
  return { mode: 'settle-pending', checked: results.length, settled, still_pending: results.length - settled, results };
}

export async function dispatch(input: {
  model: string;
  project: string;
  prompt: string;
  maxTokens: number;
  run_id?: string;
  attempt_id?: string;
  ledger?: Ledger;
  fetchImpl?: FetchLike;
  apiKey?: string;
  timeoutMs?: number;
  costRetries?: number;
  costDelayMs?: number;
  dryRun?: boolean;
  roster?: Roster;
}): Promise<DispatchReport> {
  const roster = input.roster ?? loadRoster();
  const row = requireModel(input.model, roster);
  const estimate_micro_usd = estimateMicroUsd(input.model, input.prompt.length, input.maxTokens, roster);
  const reserve_micro_usd = reservationMicroUsd(estimate_micro_usd);
  const generated = input.run_id === undefined || input.attempt_id === undefined
    ? defaultIds(input.model, input.project, input.prompt)
    : undefined;
  const run_id = input.run_id ?? generated?.run_id ?? '';
  const attempt_id = input.attempt_id ?? `${run_id}-a1`;
  const pricing_snapshot: PricingSnapshot = {
    model: row.id,
    snapshot_utc: roster.snapshot_utc,
    source: roster.source,
    price_usd_per_token: { prompt: row.price_usd_per_token.prompt, completion: row.price_usd_per_token.completion },
    prompt_chars: input.prompt.length,
    prompt_tokens_est: promptTokenEstimate(input.prompt.length),
    max_tokens: input.maxTokens,
    estimate_micro_usd,
    reserved_micro_usd: reserve_micro_usd,
  };

  if (input.dryRun) {
    const summary = input.ledger ? await input.ledger.summary(input.project) : null;
    const remaining = remainingMicro(summary);
    return {
      model: input.model, generation_id: null, state: 'dry_run', micro_usd: estimate_micro_usd, text: '', summary,
      reason: null, run_id, attempt_id, reservation_id: null, estimate_micro_usd, reserve_micro_usd, remaining,
      cost_field: null, reservation_ok: remaining === null ? null : remaining >= reserve_micro_usd, usage: null,
    };
  }

  if (!usableKey(input.apiKey)) throw new OpenRouterError('missing_api_key', { retryable: false });
  if (!input.ledger) throw new OpenRouterError('ledger_required', { retryable: false });
  const reserved = await input.ledger.reserve({
    project: input.project, run_id, attempt_id, model: input.model, est_micro_usd: reserve_micro_usd, pricing_snapshot,
  });
  if (!reserved.ok) {
    const summary = await input.ledger.summary(input.project);
    return {
      model: input.model, generation_id: null, state: 'denied', micro_usd: null, text: '', summary,
      reason: reserved.reason, run_id, attempt_id, reservation_id: null, estimate_micro_usd, reserve_micro_usd,
      remaining: reserved.remaining, cost_field: null, reservation_ok: false, usage: null,
    };
  }
  if (!reserved.reservation_id) throw new OpenRouterError('reserve_missing_id', { retryable: false });

  const key = usableKey(input.apiKey);
  if (!key) throw new OpenRouterError('missing_api_key', { retryable: false });
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
  let chat: { generation_id: string; text: string; usage: ChatUsage } | null = null;
  let failure: OpenRouterError | null = null;
  try {
    chat = await chatOnce({ model: input.model, prompt: input.prompt, maxTokens: input.maxTokens, timeoutMs, fetchImpl, apiKey: key });
  } catch (error) {
    failure = error instanceof OpenRouterError ? error : new OpenRouterError('transport', { retryable: false });
  }

  const generation_id = chat?.generation_id ?? failure?.generation_id ?? null;
  if (!generation_id) {
    const reason = failure?.reason ?? 'transport';
    await input.ledger.markPending(reserved.reservation_id, reason);
    return {
      model: input.model, generation_id: null, state: 'pending_actual', micro_usd: null, text: failure?.text ?? '',
      summary: await input.ledger.summary(input.project), reason, run_id, attempt_id,
      reservation_id: reserved.reservation_id, estimate_micro_usd, reserve_micro_usd, remaining: null,
      cost_field: null, reservation_ok: true, usage: failure?.usage ?? null,
    };
  }

  return settleOrPending({
    ledger: input.ledger, reservation_id: reserved.reservation_id, project: input.project, model: input.model,
    generation_id, text: chat?.text ?? failure?.text ?? '', usage: chat?.usage ?? failure?.usage ?? null,
    run_id, attempt_id, estimate_micro_usd, reserve_micro_usd, fetchImpl, apiKey: key,
    costRetries: input.costRetries ?? DEFAULT_COST_RETRIES,
    costDelayMs: input.costDelayMs ?? DEFAULT_COST_DELAY_MS,
    timeoutMs,
  });
}
