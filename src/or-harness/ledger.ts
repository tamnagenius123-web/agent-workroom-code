// Private JSON storage boundary. The public product uses its D1 ledger; this
// historical Node adapter remains unavailable here. Money and transport types
// are owned by client.ts, so an adapter cannot silently change their meaning.
import { boundaryUnavailable } from '../boundary.ts';
import type { Ledger, PendingMark, PricingSnapshot, ReserveInput, ReserveResult, SettleInput } from './client.ts';

export const DEFAULT_LEDGER_PATH = '.ledger/or-ledger.json';
export const LEDGER_SCHEMA = 'or-ledger.v1';

export class LedgerError extends Error {
  readonly code: 'lock_timeout' | 'missing_generation_id' | 'evidence_required' | 'settle_conflict'
    | 'not_found' | 'invalid_state' | 'invalid_argument' | 'invalid_config' | 'invalid_ledger' | 'unknown_project';
  constructor(code: LedgerError['code'], message: string) { super(message); this.name = 'LedgerError'; this.code = code; }
}

/** Old JSON cards are opaque; a new provider dispatch writes PricingSnapshot. */
export type StoredSnapshot = { model: string; [field: string]: unknown };
export type StoredReserveInput = Omit<ReserveInput, 'pricing_snapshot'> & { pricing_snapshot: PricingSnapshot | StoredSnapshot };

export interface PendingGeneration {
  reservation_id: string;
  generation_id: string;
  provider_account: string | null;
  model: string;
  project: string;
  state: 'pending_actual' | 'unknown';
  pending_reason: string | null;
}

export interface Summary { cap: number; spent: number; held: number; remaining: number }

export interface JsonLedger extends Ledger {
  reserve(input: StoredReserveInput): Promise<ReserveResult>;
  markPending(reservation_id: string, reason: string, extra?: PendingMark): Promise<void>;
  listPendingWithGeneration(): Promise<PendingGeneration[]>;
  settle(reservation_id: string, actual: SettleInput): Promise<void>;
  closeNoCharge(reservation_id: string, evidence: string): Promise<'closed_no_charge'>;
  summary(project: string): Promise<Summary>;
}

export function openLedger(_path?: string): JsonLedger {
  return boundaryUnavailable('src/or-harness/ledger.ts', 'openLedger', _path);
}
