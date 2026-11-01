// BOUNDARY CONTRACT — mirrors src/or-harness/client.ts in the gate MCP repo (agent-workroom-gate-mcp).
// Types and contract constants are declared here; every runtime entry point
// fails closed with a typed error. Phase 2 replaces this seam with gate-MCP
// calls; no harness behavior (reserving, settling, provider calls) is
// implemented or simulated here.
import { boundaryUnavailable } from '../boundary.ts';

export const DEFAULT_CHAT_TIMEOUT_MS = 60_000;
export const DEFAULT_COST_RETRIES = 10;
export const DEFAULT_COST_DELAY_MS = 2_000;
/** No automatic chat POST retries: a lost response can hide provider acceptance. */
export const CHAT_TRANSPORT_RETRIES = 0;

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

/** Structural match for src/or-harness/ledger.ts (sibling module). */
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

export { OpenRouterError as OrError };

export function loadRoster(_path?: string): Roster {
  return boundaryUnavailable('src/or-harness/client.ts', 'loadRoster', _path);
}

export function estimateMicroUsd(_model: string, _promptChars: number, _maxTokens: number, _roster?: Roster): number {
  return boundaryUnavailable('src/or-harness/client.ts', 'estimateMicroUsd', _model, _promptChars, _maxTokens, _roster);
}

export function reservationMicroUsd(_estimate: number): number {
  return boundaryUnavailable('src/or-harness/client.ts', 'reservationMicroUsd', _estimate);
}

export function defaultIds(_model: string, _project: string, _prompt: string): { run_id: string; attempt_id: string } {
  return boundaryUnavailable('src/or-harness/client.ts', 'defaultIds', _model, _project, _prompt);
}

export function roundUsdToMicro(_usd: number): number {
  return boundaryUnavailable('src/or-harness/client.ts', 'roundUsdToMicro', _usd);
}

export async function chatOnce(_input: {
  model: string;
  prompt: string;
  maxTokens: number;
  timeoutMs: number;
  fetchImpl: FetchLike;
  apiKey: string;
}): Promise<{ generation_id: string; text: string; usage: ChatUsage }> {
  return boundaryUnavailable('src/or-harness/client.ts', 'chatOnce', _input);
}

export async function getGenerationCost(_id: string, _options: {
  fetchImpl: FetchLike;
  apiKey: string;
  retries?: number;
  delayMs?: number;
  timeoutMs?: number;
}): Promise<GenerationCost | null> {
  return boundaryUnavailable('src/or-harness/client.ts', 'getGenerationCost', _id, _options);
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

export async function settlePending(_input: {
  ledger: SettlePendingLedger;
  fetchImpl?: FetchLike;
  apiKey: string;
  costRetries?: number;
  costDelayMs?: number;
  timeoutMs?: number;
}): Promise<SettlePendingReport> {
  return boundaryUnavailable('src/or-harness/client.ts', 'settlePending', _input);
}

export async function dispatch(_input: {
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
  return boundaryUnavailable('src/or-harness/client.ts', 'dispatch', _input);
}
