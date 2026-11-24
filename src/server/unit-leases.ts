// ORCH-A1 unit leases (migration 0077): one lease row per unit, claimed with a
// single atomic upsert so two holders cannot both win. This module is the
// lease core the orchestration paths share; it is stateless apart from the
// unit_leases table, so a holder process can crash and restart and the table
// alone decides who holds what. Time is an explicit input (nowMs) — callers
// pass server time, tests pass a fixture clock.
//
// Invariants exercised against local D1 in tests/unit-leases-chaos.test.ts:
// - No double occupancy: a live 'held' lease blocks every other holder.
// - Fencing: heartbeat requires a live lease; release changes only a held
//   row with the current holder and generation. A holder that lost its
//   lease to expiry + reclaim cannot disturb the new holder's row.
// - Generation fence (0084): holder id alone cannot tell two executions of
//   the same holder apart, so every successful claim issues a generation
//   (incremented on takeover and on refresh). Heartbeat/release must present
//   the generation from the caller's latest claim; a stale execution of the
//   same holder id, still holding an older generation, is rejected.
// - Expiry is lazy and total: once lease_until <= now the lease no longer
//   fences anyone; sweepExpired only rewrites the state label.
// - Retry: the holder re-claiming its own live lease succeeds and
//   refreshes it, so a retried claim after a lost response is safe. The
//   retry returns the new generation, which supersedes the lost one.
// - Mutation receipts: RETURNING identifies the row changed by this call.
//   A delayed response cannot hand an earlier execution a later token.
//   Success records the mutation's linearization point; it does not promise
//   that another execution has not superseded the lease before delivery.

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
  /** True when this claim acquired a live lease at its atomic mutation. */
  acquired: boolean;
  /** True when this call created the lease or took it over (not a refresh). */
  fresh: boolean;
  /** This claim's returned row, or the transaction's incumbent on rejection. */
  lease: UnitLease | null;
}

function checkId(value: string, name: string): void {
  if (typeof value !== 'string' || !value) throw new Error(`unit lease: ${name} is required`);
}

function checkNow(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('unit lease: now must be a non-negative safe integer');
}

function check(unitId: string, holder: string, nowMs: number, ttlMs: number): void {
  checkId(unitId, 'unit_id');
  checkId(holder, 'holder');
  checkNow(nowMs);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('unit lease: ttl must be a positive safe integer');
  if (!Number.isSafeInteger(nowMs + ttlMs)) throw new Error('unit lease: expiry exceeds the safe integer range');
}

export async function getUnitLease(db: Database, unitId: string): Promise<UnitLease | null> {
  checkId(unitId, 'unit_id');
  return db.prepare('SELECT unit_id,holder,lease_until,heartbeat_at,state,generation FROM unit_leases WHERE unit_id=?')
    .bind(unitId).first<UnitLease>();
}

/** A lease fences others only while held and not yet at its expiry instant. */
export function leaseLive(lease: UnitLease | null, nowMs: number): boolean {
  checkNow(nowMs);
  return !!lease && lease.state === 'held' && lease.lease_until > nowMs;
}

export async function claimUnitLease(db: Database, unitId: string, holder: string, nowMs: number, ttlMs: number): Promise<ClaimOutcome> {
  check(unitId, holder, nowMs, ttlMs);
  // One statement is the whole race: the upsert lands only when the stored
  // row is free (released/expired), past its expiry, or already the caller's.
  // A landed claim also bumps the generation, so any earlier execution of
  // this same holder id is fenced out from this instant.
  // Keep the pre-state read in the same D1 transaction so `fresh` describes
  // this mutation too. A separate SELECT after writing can observe a later
  // claim and must never be used to choose the caller's fencing token.
  const result = await db.batch<UnitLease>([
    db.prepare('SELECT unit_id,holder,lease_until,heartbeat_at,state,generation FROM unit_leases WHERE unit_id=?').bind(unitId),
    db.prepare(`INSERT INTO unit_leases(unit_id,holder,lease_until,heartbeat_at,state,generation) VALUES (?,?,?,?, 'held', 1)
      ON CONFLICT(unit_id) DO UPDATE SET holder=excluded.holder,lease_until=excluded.lease_until,heartbeat_at=excluded.heartbeat_at,state='held',generation=unit_leases.generation+1
      WHERE (unit_leases.state<>'held' OR unit_leases.lease_until<=? OR unit_leases.holder=?)
        AND unit_leases.generation>=0 AND unit_leases.generation<?
      RETURNING unit_id,holder,lease_until,heartbeat_at,state,generation`)
      .bind(unitId, holder, nowMs + ttlMs, nowMs, nowMs, holder, Number.MAX_SAFE_INTEGER),
  ]);
  const before = result[0]?.results[0] ?? null;
  const lease = result[1]?.results[0] ?? null;
  if (!lease) return { acquired: false, fresh: false, lease: before };
  const wasMine = !!before && before.holder === holder && leaseLive(before, nowMs);
  return { acquired: true, fresh: !wasMine, lease };
}

function checkGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('unit lease: generation must be a positive safe integer');
}

export async function heartbeatUnitLease(db: Database, unitId: string, holder: string, generation: number, nowMs: number, ttlMs: number): Promise<boolean> {
  check(unitId, holder, nowMs, ttlMs);
  checkGeneration(generation);
  // Fenced on holder + generation + live lease: an expired lease cannot be
  // revived by a heartbeat (the holder must re-claim), a reclaimed lease
  // belongs to the new holder, and an older execution of the same holder id
  // carries a stale generation — all three match no row and return false.
  const result = await db.prepare(`UPDATE unit_leases SET lease_until=?,heartbeat_at=? WHERE unit_id=? AND holder=? AND generation=? AND state='held' AND lease_until>?
    RETURNING unit_id`)
    .bind(nowMs + ttlMs, nowMs, unitId, holder, generation, nowMs).all<{ unit_id: string }>();
  return result.results.length === 1;
}

export async function releaseUnitLease(db: Database, unitId: string, holder: string, generation: number): Promise<boolean> {
  checkId(unitId, 'unit_id');
  checkId(holder, 'holder');
  checkGeneration(generation);
  const result = await db.prepare(`UPDATE unit_leases SET state='released' WHERE unit_id=? AND holder=? AND generation=? AND state='held'
    RETURNING unit_id`)
    .bind(unitId, holder, generation).all<{ unit_id: string }>();
  return result.results.length === 1;
}

/** Labels every held-but-expired row 'expired'. Returns the swept unit ids. */
export async function sweepExpiredUnitLeases(db: Database, nowMs: number): Promise<string[]> {
  checkNow(nowMs);
  const rows = await db.prepare(`UPDATE unit_leases SET state='expired' WHERE state='held' AND lease_until<=? RETURNING unit_id`)
    .bind(nowMs).all<{ unit_id: string }>();
  return rows.results.map((r) => r.unit_id).sort();
}
