// ORCH-A1 unit leases (migration 0077): one lease row per unit, claimed with a
// single atomic upsert so two holders cannot both win. This module is the
// lease core the orchestration paths share; it is stateless apart from the
// unit_leases table, so a holder process can crash and restart and the table
// alone decides who holds what. Time is an explicit input (nowMs) — callers
// pass server time, tests pass a fixture clock.
//
// Invariants (proved in tests/unit-leases-chaos.test.ts):
// - No double occupancy: a live 'held' lease blocks every other holder.
// - Fencing: heartbeat/release only apply to the current holder of a live
//   lease. A holder that lost its lease to expiry + reclaim cannot extend,
//   release, or otherwise disturb the new holder's row.
// - Generation fence (0084): holder id alone cannot tell two executions of
//   the same holder apart, so every successful claim issues a generation
//   (incremented on takeover and on refresh). Heartbeat/release must present
//   the generation from the caller's latest claim; a stale execution of the
//   same holder id, still holding an older generation, is rejected.
// - Expiry is lazy and total: once lease_until <= now the lease no longer
//   fences anyone; sweepExpired only rewrites the state label.
// - Idempotent retry: the holder re-claiming its own live lease succeeds and
//   refreshes it, so a retried claim after a lost response is safe. The
//   retry returns the new generation, which supersedes the lost one.

import type { Database } from './db.ts';

export type UnitLeaseState = 'held' | 'released' | 'expired';
export interface UnitLease {
  unit_id: string;
  holder: string;
  lease_until: number;
  heartbeat_at: number;
  state: UnitLeaseState;
  /** Fencing token issued by the latest successful claim (0084). */
  generation: number;
}
export interface ClaimOutcome {
  /** True when the caller holds a live lease after this call. */
  acquired: boolean;
  /** True when this call created the lease or took it over (not a refresh). */
  fresh: boolean;
  /** The row as stored after the call, or null when the unit has no row. */
  lease: UnitLease | null;
}

function check(unitId: string, holder: string, ttlMs: number): void {
  if (!unitId) throw new Error('unit lease: unit_id is required');
  if (!holder) throw new Error('unit lease: holder is required');
  if (!(ttlMs > 0)) throw new Error('unit lease: ttl must be positive');
}

export async function getUnitLease(db: Database, unitId: string): Promise<UnitLease | null> {
  return db.prepare('SELECT unit_id,holder,lease_until,heartbeat_at,state,generation FROM unit_leases WHERE unit_id=?')
    .bind(unitId).first<UnitLease>();
}

/** A lease fences others only while held and not yet at its expiry instant. */
export function leaseLive(lease: UnitLease | null, nowMs: number): boolean {
  return !!lease && lease.state === 'held' && lease.lease_until > nowMs;
}

export async function claimUnitLease(db: Database, unitId: string, holder: string, nowMs: number, ttlMs: number): Promise<ClaimOutcome> {
  check(unitId, holder, ttlMs);
  const before = await getUnitLease(db, unitId);
  const wasMine = !!before && before.holder === holder && leaseLive(before, nowMs);
  // One statement is the whole race: the upsert lands only when the stored
  // row is free (released/expired), past its expiry, or already the caller's.
  // A landed claim also bumps the generation, so any earlier execution of
  // this same holder id is fenced out from this instant.
  await db.prepare(`INSERT INTO unit_leases(unit_id,holder,lease_until,heartbeat_at,state,generation) VALUES (?,?,?,?, 'held', 1)
    ON CONFLICT(unit_id) DO UPDATE SET holder=excluded.holder,lease_until=excluded.lease_until,heartbeat_at=excluded.heartbeat_at,state='held',generation=unit_leases.generation+1
    WHERE unit_leases.state<>'held' OR unit_leases.lease_until<=? OR unit_leases.holder=?`)
    .bind(unitId, holder, nowMs + ttlMs, nowMs, nowMs, holder).all();
  const lease = await getUnitLease(db, unitId);
  const acquired = !!lease && lease.holder === holder && leaseLive(lease, nowMs);
  return { acquired, fresh: acquired && !wasMine, lease };
}

function checkGeneration(generation: number): void {
  if (!Number.isInteger(generation) || generation < 1) throw new Error('unit lease: generation must be a positive integer');
}

export async function heartbeatUnitLease(db: Database, unitId: string, holder: string, generation: number, nowMs: number, ttlMs: number): Promise<boolean> {
  check(unitId, holder, ttlMs);
  checkGeneration(generation);
  // Fenced on holder + generation + live lease: an expired lease cannot be
  // revived by a heartbeat (the holder must re-claim), a reclaimed lease
  // belongs to the new holder, and an older execution of the same holder id
  // carries a stale generation — all three match no row and return false.
  await db.prepare(`UPDATE unit_leases SET lease_until=?,heartbeat_at=? WHERE unit_id=? AND holder=? AND generation=? AND state='held' AND lease_until>?`)
    .bind(nowMs + ttlMs, nowMs, unitId, holder, generation, nowMs).all();
  const lease = await getUnitLease(db, unitId);
  return !!lease && lease.holder === holder && lease.generation === generation && lease.state === 'held' && lease.heartbeat_at === nowMs && lease.lease_until === nowMs + ttlMs;
}

export async function releaseUnitLease(db: Database, unitId: string, holder: string, generation: number): Promise<boolean> {
  if (!unitId || !holder) throw new Error('unit lease: unit_id and holder are required');
  checkGeneration(generation);
  await db.prepare(`UPDATE unit_leases SET state='released' WHERE unit_id=? AND holder=? AND generation=? AND state='held'`)
    .bind(unitId, holder, generation).all();
  const lease = await getUnitLease(db, unitId);
  return !!lease && lease.holder === holder && lease.generation === generation && lease.state === 'released';
}

/** Labels every held-but-expired row 'expired'. Returns the swept unit ids. */
export async function sweepExpiredUnitLeases(db: Database, nowMs: number): Promise<string[]> {
  const rows = await db.prepare(`SELECT unit_id FROM unit_leases WHERE state='held' AND lease_until<=? ORDER BY unit_id`)
    .bind(nowMs).all<{ unit_id: string }>();
  const ids = rows.results.map((r) => r.unit_id);
  if (ids.length) {
    await db.prepare(`UPDATE unit_leases SET state='expired' WHERE state='held' AND lease_until<=?`).bind(nowMs).all();
  }
  return ids;
}
