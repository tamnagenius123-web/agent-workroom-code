// BOUNDARY CONTRACT — mirrors src/or-harness/ledger.ts in the gate MCP repo (agent-workroom-gate-mcp).
// Types and contract constants are declared here; every runtime entry point
// fails closed with a typed error. Phase 2 replaces this seam with gate-MCP
// calls; no harness behavior (reserving, settling, provider calls) is
// implemented or simulated here.
import { boundaryUnavailable } from '../boundary.ts';

export const DEFAULT_LEDGER_PATH = '.ledger/or-ledger.json';
export const LEDGER_SCHEMA = 'or-ledger.v1';

export type ReservationState = 'open' | 'pending_actual' | 'unknown' | 'settled' | 'closed_no_charge';
export type CostField = 'total_cost' | 'usage';

export class LedgerError extends Error {
  readonly code:
    | 'lock_timeout'
    | 'missing_generation_id'
    | 'evidence_required'
    | 'settle_conflict'
    | 'not_found'
    | 'invalid_state'
    | 'invalid_argument'
    | 'invalid_config'
    | 'invalid_ledger'
    | 'unknown_project';

  constructor(code: LedgerError['code'], message: string) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

/** Recorded price card. `model` is required. Fields match the dispatch client's snapshot. */
export interface PricingSnapshot {
  model: string;
  snapshot_utc?: string;
  source?: string;
  price_usd_per_token?: { prompt: string; completion: string };
  prompt_chars?: number;
  prompt_tokens_est?: number;
  max_tokens?: number;
  estimate_micro_usd?: number;
  reserved_micro_usd?: number;
  captured_at?: string;
  est_micro_usd?: number;
  unit_prices?: { prompt?: string; completion?: string };
}

export interface TokenCounts {
  prompt: number | null;
  completion: number | null;
  total: number | null;
}

export interface ReserveInput {
  project: string;
  run_id: string;
  attempt_id: string;
  model: string;
  est_micro_usd: number;
  pricing_snapshot: PricingSnapshot;
}

export type ReserveResult =
  | { ok: true; reservation_id: string }
  | { ok: false; reason: 'over_budget'; remaining: number };

export interface SettleInput {
  generation_id: string;
  micro_usd: number;
  cost_field: CostField;
  provider_account: string | null;
  model: string;
  tokens: TokenCounts;
}

/** Fields known when a provider id exists but the charge is not yet visible. */
export interface PendingExtra {
  generation_id?: string;
  provider_account?: string | null;
  model?: string;
}

/** A counted hold that a later /generation lookup can still settle. */
export interface PendingGeneration {
  reservation_id: string;
  generation_id: string;
  provider_account: string | null;
  model: string;
  project: string;
  state: 'pending_actual' | 'unknown';
  pending_reason: string | null;
}

export interface Summary {
  cap: number;
  spent: number;
  held: number;
  remaining: number;
}

export interface Ledger {
  reserve(input: ReserveInput): Promise<ReserveResult>;
  /**
   * Moves the hold to pending_actual. Does not zero it and does not write an actual.
   * When extra.generation_id is set, it is stored on the reservation so a later lookup can settle.
   */
  markPending(reservation_id: string, reason: string, extra?: PendingExtra): Promise<void>;
  /** pending_actual and unknown holds that already have a provider generation id. */
  listPendingWithGeneration(): Promise<PendingGeneration[]>;
  settle(reservation_id: string, actual: SettleInput): Promise<void>;
  closeNoCharge(reservation_id: string, evidence: string): Promise<'closed_no_charge'>;
  summary(project: string): Promise<Summary>;
}

export function openLedger(_path?: string): Ledger {
  return boundaryUnavailable('src/or-harness/ledger.ts', 'openLedger', _path);
}
