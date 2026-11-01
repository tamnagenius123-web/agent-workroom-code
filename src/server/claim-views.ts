// Read models over claim and review rows. No clock and no I/O.
// STALE_CLAIM_THRESHOLD_MS is 30 minutes. tasks.LOCAL_LEASE_MS is the 30 second
// synthetic lease fence, and notify.CLAIM_MS is the 60 second webhook delivery
// lease. Neither is a stale-claim age.

export const STALE_CLAIM_THRESHOLD_MS = 30 * 60 * 1000;

const CLAIMED_STATES = new Set(['in_progress', 'claimed']);
const AWAITING_STATES = new Set(['review', 'awaiting_verification']);

export interface ClaimRow {
  unit_id: string;
  assignee: string | null;
  state: string;
  claimed_at_ms: number | null;
}

export interface StaleClaim {
  unit_id: string;
  assignee: string;
  claimed_at: string;
  age_minutes: number;
}

export interface VerificationRow {
  unit_id: string;
  state: string;
  worker_principal: string;
  verifier_principal: string;
  awaiting_since_ms: number;
}

export interface VerifierQueueUnit {
  unit_id: string;
  worker_principal: string;
  awaiting_since: string;
}

export interface FlaggedVerification {
  unit_id: string;
  worker_principal: string;
  verifier_principal: string;
  awaiting_since: string;
  flag: 'worker_equals_verifier';
}

export interface VerifierQueueGroup {
  verifier: string;
  units: VerifierQueueUnit[];
}

export interface VerifierQueueView {
  groups: VerifierQueueGroup[];
  flagged: FlaggedVerification[];
}

function named(value: string | null): value is string {
  return typeof value === 'string' && value.length > 0;
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Claimed or in-progress rows older than the threshold, oldest first. Age must exceed the threshold. */
export function listStaleClaims(rows: readonly ClaimRow[], nowMs: number, thresholdMs = STALE_CLAIM_THRESHOLD_MS): StaleClaim[] {
  if (!Number.isFinite(nowMs) || !Number.isFinite(thresholdMs) || thresholdMs < 0) return [];
  const out: StaleClaim[] = [];
  for (const row of rows) {
    if (!CLAIMED_STATES.has(row.state) || !named(row.unit_id) || !named(row.assignee)) continue;
    if (typeof row.claimed_at_ms !== 'number' || !Number.isFinite(row.claimed_at_ms)) continue;
    const ageMs = nowMs - row.claimed_at_ms;
    if (ageMs <= thresholdMs) continue;
    out.push({
      unit_id: row.unit_id,
      assignee: row.assignee,
      claimed_at: new Date(row.claimed_at_ms).toISOString(),
      age_minutes: Math.floor(ageMs / 60_000),
    });
  }
  out.sort((a, b) => byText(a.claimed_at, b.claimed_at) || byText(a.unit_id, b.unit_id));
  return out;
}

interface Pending {
  unit_id: string;
  worker_principal: string;
  verifier_principal: string;
  awaiting_since_ms: number;
}

function keepOlder(bucket: Map<string, Pending>, row: Pending): void {
  const key = row.unit_id + '\0' + row.verifier_principal;
  const prev = bucket.get(key);
  if (!prev || row.awaiting_since_ms < prev.awaiting_since_ms) bucket.set(key, row);
}

function byAge(a: Pending, b: Pending): number {
  return a.awaiting_since_ms < b.awaiting_since_ms ? -1
    : a.awaiting_since_ms > b.awaiting_since_ms ? 1
    : byText(a.unit_id, b.unit_id) || byText(a.verifier_principal, b.verifier_principal);
}

/**
 * Awaiting-verification rows where the verifier is not the worker, grouped by verifier.
 * Inside a group, and across groups, the oldest awaiting_since comes first.
 * A row whose worker principal equals its verifier principal is flagged and is not a valid queue entry.
 */
export function verifierQueue(rows: readonly VerificationRow[]): VerifierQueueView {
  const valid = new Map<string, Pending>();
  const flagged = new Map<string, Pending>();
  for (const row of rows) {
    if (!AWAITING_STATES.has(row.state)) continue;
    if (!named(row.unit_id) || !named(row.worker_principal) || !named(row.verifier_principal)) continue;
    if (typeof row.awaiting_since_ms !== 'number' || !Number.isFinite(row.awaiting_since_ms)) continue;
    const pending: Pending = {
      unit_id: row.unit_id,
      worker_principal: row.worker_principal,
      verifier_principal: row.verifier_principal,
      awaiting_since_ms: row.awaiting_since_ms,
    };
    keepOlder(row.worker_principal === row.verifier_principal ? flagged : valid, pending);
  }
  const byVerifier = new Map<string, Pending[]>();
  for (const row of valid.values()) {
    const list = byVerifier.get(row.verifier_principal);
    if (list) list.push(row);
    else byVerifier.set(row.verifier_principal, [row]);
  }
  const groups: { verifier: string; oldest: number; units: VerifierQueueUnit[] }[] = [];
  for (const [verifier, units] of byVerifier) {
    units.sort(byAge);
    const oldest = units[0];
    if (!oldest) continue;
    groups.push({
      verifier,
      oldest: oldest.awaiting_since_ms,
      units: units.map(unit => ({
        unit_id: unit.unit_id,
        worker_principal: unit.worker_principal,
        awaiting_since: new Date(unit.awaiting_since_ms).toISOString(),
      })),
    });
  }
  groups.sort((a, b) => a.oldest < b.oldest ? -1 : a.oldest > b.oldest ? 1 : byText(a.verifier, b.verifier));
  const flaggedRows = [...flagged.values()].sort(byAge);
  return {
    groups: groups.map(group => ({ verifier: group.verifier, units: group.units })),
    flagged: flaggedRows.map(row => ({
      unit_id: row.unit_id,
      worker_principal: row.worker_principal,
      verifier_principal: row.verifier_principal,
      awaiting_since: new Date(row.awaiting_since_ms).toISOString(),
      flag: 'worker_equals_verifier',
    })),
  };
}
