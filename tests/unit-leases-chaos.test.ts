import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import { migrate } from '../scripts/local-harness.ts';
import type { Database, Statement, Value } from '../src/server/db.ts';
import {
  claimUnitLease, getUnitLease, heartbeatUnitLease, leaseLive, releaseUnitLease, sweepExpiredUnitLeases,
} from '../src/server/unit-leases.ts';

// U8-G6: concurrency + chaos invariants for ORCH-A1 unit leases (migration
// 0077). Everything runs against a local fixture D1 with an injected clock —
// no deployed worker, no network, no real time. "Chaos" here means holder
// crash (heartbeats stop), restart (a fresh caller with the same holder id),
// and claim storms, all replayed deterministically against the lease table.

const T0 = 1_800_000_000_000;

async function start(): Promise<{ db: Database; close: () => Promise<void> }> {
  const d1 = await cloneD1(9999);
  const mf = new Miniflare({
    modules: true,
    script: 'export default { async fetch() { return new Response(null, { status: 204 }); } }',
    compatibilityDate: '2026-07-28',
    d1Databases: { DB: D1_TEMPLATE_NAME }, d1Persist: d1.dir,
    cf: false,
  } as ConstructorParameters<typeof Miniflare>[0]);
  await mf.ready;
  const db = await mf.getD1Database('DB') as unknown as Database;
  await migrate(db, 9999);
  return { db, close: async () => { await mf.dispose(); d1.cleanup(); } };
}

async function rows(db: Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM unit_leases').first<{ n: number }>();
  return row?.n ?? -1;
}

/** Delay transport around a real D1 mutation; SQL and rows are never mocked. */
function gateFirstMutation(database: Database, timing: 'before' | 'after') {
  let signal!: () => void;
  let resume!: () => void;
  const reached = new Promise<void>((resolve) => { signal = resolve; });
  const released = new Promise<void>((resolve) => { resume = resolve; });
  let used = false;
  const native = new WeakMap<Statement, Statement>();
  const queries = new WeakMap<Statement, string>();
  async function invoke<T>(sql: string[], execute: () => Promise<T>): Promise<T> {
    const gated = !used && sql.some((query) => /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(query));
    if (gated) used = true;
    if (gated && timing === 'before') { signal(); await released; }
    const value = await execute();
    if (gated && timing === 'after') { signal(); await released; }
    return value;
  }
  function wrap(statement: Statement, sql: string): Statement {
    const wrapped: Statement = {
      bind(...args: Value[]) { return wrap(statement.bind(...args), sql); },
      first<T>() { return invoke([sql], () => statement.first<T>()); },
      all<T>() { return invoke([sql], () => statement.all<T>()); },
    };
    native.set(wrapped, statement);
    queries.set(wrapped, sql);
    return wrapped;
  }
  const db: Database = {
    prepare(sql) { return wrap(database.prepare(sql), sql); },
    batch<T>(statements: Statement[]) {
      return invoke(statements.map((statement) => queries.get(statement) ?? ''),
        () => database.batch<T>(statements.map((statement) => native.get(statement) ?? statement)));
    },
  };
  return { db, reached, resume };
}

test('a live lease blocks every other holder (no double occupancy)', async () => {
  const { db, close } = await start();
  try {
    const a = await claimUnitLease(db, 'U1', 'agent:alpha', T0, 30_000);
    assert.equal(a.acquired, true);
    assert.equal(a.fresh, true);
    const b = await claimUnitLease(db, 'U1', 'agent:beta', T0 + 1, 30_000);
    assert.equal(b.acquired, false);
    assert.equal(b.lease?.holder, 'agent:alpha');
    assert.equal(await rows(db), 1);
  } finally { await close(); }
});

test('claim storm: eight concurrent holders, exactly one winner, one row', async () => {
  const { db, close } = await start();
  try {
    const holders = Array.from({ length: 8 }, (_, i) => 'agent:h' + i);
    const outcomes = await Promise.all(holders.map((h) => claimUnitLease(db, 'U-storm', h, T0, 30_000)));
    const winners = outcomes.filter((o) => o.acquired);
    assert.equal(winners.length, 1);
    assert.equal(await rows(db), 1);
    const lease = await getUnitLease(db, 'U-storm');
    assert.equal(lease?.holder, winners[0]?.lease?.holder);
    assert.equal(leaseLive(lease, T0 + 1), true);
  } finally { await close(); }
});

test('idempotent retry: the holder re-claiming its own lease always succeeds', async () => {
  const { db, close } = await start();
  try {
    const first = await claimUnitLease(db, 'U2', 'agent:alpha', T0, 30_000);
    assert.equal(first.acquired, true);
    assert.equal(first.lease?.generation, 1);
    for (let i = 1; i <= 3; i++) {
      const retry = await claimUnitLease(db, 'U2', 'agent:alpha', T0 + i * 1000, 30_000);
      assert.equal(retry.acquired, true, 'retry ' + i);
      assert.equal(retry.fresh, false, 'retry ' + i + ' is a refresh, not a takeover');
      assert.equal(retry.lease?.lease_until, T0 + i * 1000 + 30_000);
      // Each landed claim issues the next generation, superseding the last.
      assert.equal(retry.lease?.generation, 1 + i, 'retry ' + i + ' generation');
    }
    assert.equal(await rows(db), 1);
  } finally { await close(); }
});

test('expiry + reclaim: the stale holder is fenced out of heartbeat and release', async () => {
  const { db, close } = await start();
  try {
    const a = await claimUnitLease(db, 'U3', 'agent:alpha', T0, 1_000);
    // Alpha crashes: no heartbeat. The lease lapses and beta takes over.
    const b = await claimUnitLease(db, 'U3', 'agent:beta', T0 + 1_001, 30_000);
    assert.equal(b.acquired, true);
    assert.equal(b.fresh, true);
    assert.equal(b.lease?.generation, (a.lease?.generation ?? 0) + 1);
    // Alpha restarts with stale state and tries to act on the lease it lost.
    assert.equal(await heartbeatUnitLease(db, 'U3', 'agent:alpha', a.lease?.generation ?? -1, T0 + 1_002, 30_000), false);
    assert.equal(await releaseUnitLease(db, 'U3', 'agent:alpha', a.lease?.generation ?? -1), false);
    const lease = await getUnitLease(db, 'U3');
    assert.equal(lease?.holder, 'agent:beta');
    assert.equal(lease?.state, 'held');
    assert.equal(leaseLive(lease, T0 + 1_002), true);
  } finally { await close(); }
});

test('heartbeat extends a live lease and keeps rivals out past the original expiry', async () => {
  const { db, close } = await start();
  try {
    const a = await claimUnitLease(db, 'U4', 'agent:alpha', T0, 1_000);
    const gen = a.lease?.generation ?? -1;
    assert.equal(await heartbeatUnitLease(db, 'U4', 'agent:alpha', gen, T0 + 500, 1_000), true);
    const b = await claimUnitLease(db, 'U4', 'agent:beta', T0 + 1_200, 30_000);
    assert.equal(b.acquired, false);
    // A non-holder heartbeat never extends anything, even with the live generation.
    assert.equal(await heartbeatUnitLease(db, 'U4', 'agent:beta', gen, T0 + 1_300, 99_000), false);
    const lease = await getUnitLease(db, 'U4');
    assert.equal(lease?.lease_until, T0 + 1_500);
  } finally { await close(); }
});

test('an expired lease cannot be revived by heartbeat; the holder must re-claim', async () => {
  const { db, close } = await start();
  try {
    const a = await claimUnitLease(db, 'U5', 'agent:alpha', T0, 1_000);
    assert.equal(await heartbeatUnitLease(db, 'U5', 'agent:alpha', a.lease?.generation ?? -1, T0 + 1_500, 1_000), false);
    const again = await claimUnitLease(db, 'U5', 'agent:alpha', T0 + 1_500, 1_000);
    assert.equal(again.acquired, true);
    assert.equal(again.fresh, true);
    assert.equal(again.lease?.generation, (a.lease?.generation ?? 0) + 1);
  } finally { await close(); }
});

test('release frees the unit at once and only the holder can release', async () => {
  const { db, close } = await start();
  try {
    const a = await claimUnitLease(db, 'U6', 'agent:alpha', T0, 30_000);
    const gen = a.lease?.generation ?? -1;
    assert.equal(await releaseUnitLease(db, 'U6', 'agent:beta', gen), false);
    assert.equal(await releaseUnitLease(db, 'U6', 'agent:alpha', gen), true);
    const b = await claimUnitLease(db, 'U6', 'agent:beta', T0 + 1, 30_000);
    assert.equal(b.acquired, true);
    assert.equal(b.fresh, true);
    // Releasing twice is a no-op, not an error (idempotent teardown).
    assert.equal(await releaseUnitLease(db, 'U6', 'agent:alpha', gen), false);
  } finally { await close(); }
});

test('sweep labels only held-and-expired rows and is itself idempotent', async () => {
  const { db, close } = await start();
  try {
    await claimUnitLease(db, 'U7a', 'agent:alpha', T0, 1_000);
    await claimUnitLease(db, 'U7b', 'agent:beta', T0, 60_000);
    const c = await claimUnitLease(db, 'U7c', 'agent:alpha', T0, 1_000);
    await releaseUnitLease(db, 'U7c', 'agent:alpha', c.lease?.generation ?? -1);
    assert.deepEqual(await sweepExpiredUnitLeases(db, T0 + 2_000), ['U7a']);
    assert.equal((await getUnitLease(db, 'U7a'))?.state, 'expired');
    assert.equal((await getUnitLease(db, 'U7b'))?.state, 'held');
    assert.equal((await getUnitLease(db, 'U7c'))?.state, 'released');
    assert.deepEqual(await sweepExpiredUnitLeases(db, T0 + 2_000), []);
  } finally { await close(); }
});

test('chaos restart: a restarted holder re-claims to learn the current generation', async () => {
  const { db, close } = await start();
  try {
    // Holder process claims, then "restarts": no in-memory state survives,
    // so it cannot know the generation it was issued. The restart re-claims
    // (a refresh of its own live lease) to learn the current generation,
    // and only then can it heartbeat. The pre-restart generation is stale
    // the moment the refresh lands.
    const first = await claimUnitLease(db, 'U8', 'agent:alpha', T0, 5_000);
    const staleGen = first.lease?.generation ?? -1;
    const restarted = await claimUnitLease(db, 'U8', 'agent:alpha', T0 + 1_000, 5_000);
    assert.equal(restarted.acquired, true);
    assert.equal(restarted.fresh, false);
    const gen = restarted.lease?.generation ?? -1;
    assert.equal(gen, staleGen + 1);
    assert.equal(await heartbeatUnitLease(db, 'U8', 'agent:alpha', staleGen, T0 + 2_000, 5_000), false);
    assert.equal(await heartbeatUnitLease(db, 'U8', 'agent:alpha', gen, T0 + 4_000, 5_000), true);
    const b = await claimUnitLease(db, 'U8', 'agent:beta', T0 + 8_500, 30_000);
    assert.equal(b.acquired, false);
    // Alpha finally dies for real; after the extended expiry beta takes over.
    const b2 = await claimUnitLease(db, 'U8', 'agent:beta', T0 + 9_001, 30_000);
    assert.equal(b2.acquired, true);
  } finally { await close(); }
});

test('same holder re-claim: the stale generation cannot heartbeat or release the new lease', async () => {
  const { db, close } = await start();
  try {
    // Execution 1 of alpha claims, then its lease lapses while a delayed
    // heartbeat/release from execution 1 is still in flight.
    const exec1 = await claimUnitLease(db, 'U10', 'agent:alpha', T0, 1_000);
    const gen1 = exec1.lease?.generation ?? -1;
    // Execution 2 of the same holder id re-claims after expiry: a new lease
    // with a new generation, indistinguishable by holder id alone.
    const exec2 = await claimUnitLease(db, 'U10', 'agent:alpha', T0 + 1_001, 30_000);
    assert.equal(exec2.acquired, true);
    assert.equal(exec2.fresh, true);
    const gen2 = exec2.lease?.generation ?? -1;
    assert.equal(gen2, gen1 + 1);
    // Execution 1's delayed operations arrive now and must be rejected:
    // they may not extend, and may not release, execution 2's lease.
    assert.equal(await heartbeatUnitLease(db, 'U10', 'agent:alpha', gen1, T0 + 1_002, 99_000), false);
    assert.equal(await releaseUnitLease(db, 'U10', 'agent:alpha', gen1), false);
    const lease = await getUnitLease(db, 'U10');
    assert.equal(lease?.state, 'held');
    assert.equal(lease?.generation, gen2);
    assert.equal(lease?.lease_until, T0 + 1_001 + 30_000);
    // Execution 2's own operations still work with its generation.
    assert.equal(await heartbeatUnitLease(db, 'U10', 'agent:alpha', gen2, T0 + 2_000, 30_000), true);
    assert.equal(await releaseUnitLease(db, 'U10', 'agent:alpha', gen2), true);
  } finally { await close(); }
});

test('units are isolated: contention on one unit never touches another', async () => {
  const { db, close } = await start();
  try {
    const [a, b] = await Promise.all([
      claimUnitLease(db, 'U9a', 'agent:alpha', T0, 30_000),
      claimUnitLease(db, 'U9b', 'agent:alpha', T0, 30_000),
    ]);
    assert.equal(a.acquired, true);
    assert.equal(b.acquired, true);
    assert.equal(await rows(db), 2);
  } finally { await close(); }
});

test('invalid claims are rejected before touching the table', async () => {
  const { db, close } = await start();
  try {
    await assert.rejects(() => claimUnitLease(db, '', 'agent:alpha', T0, 1_000));
    await assert.rejects(() => claimUnitLease(db, 'Ux', '', T0, 1_000));
    await assert.rejects(() => claimUnitLease(db, 'Ux', 'agent:alpha', T0, 0));
    assert.equal(await rows(db), 0);
  } finally { await close(); }
});

test('same-holder overlapping claims return their own exact generations after a delayed response', async () => {
  const { db, close } = await start();
  const first = gateFirstMutation(db, 'after');
  try {
    const pending = claimUnitLease(first.db, 'U-returning', 'agent:alpha', T0, 30_000);
    await first.reached;
    const successor = await claimUnitLease(db, 'U-returning', 'agent:alpha', T0 + 1, 30_000);
    first.resume();
    const predecessor = await pending;
    assert.equal(predecessor.acquired, true);
    assert.equal(predecessor.fresh, true);
    assert.equal(predecessor.lease?.generation, 1, 'the first caller may never receive its successor token');
    assert.equal(predecessor.lease?.heartbeat_at, T0);
    assert.equal(successor.acquired, true);
    assert.equal(successor.fresh, false);
    assert.equal(successor.lease?.generation, 2);
    assert.equal(await heartbeatUnitLease(db, 'U-returning', 'agent:alpha', predecessor.lease!.generation, T0 + 2, 30_000), false);
  } finally { first.resume(); await close(); }
});

test('same-holder claim storm issues eight distinct generations and only the newest can heartbeat', async () => {
  const { db, close } = await start();
  try {
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => claimUnitLease(db, 'U-same-storm', 'agent:alpha', T0, 30_000)));
    assert.equal(outcomes.filter((outcome) => outcome.acquired).length, 8);
    assert.equal(outcomes.filter((outcome) => outcome.fresh).length, 1);
    const generations = outcomes.map((outcome) => outcome.lease!.generation).sort((a, b) => a - b);
    assert.deepEqual(generations, [1, 2, 3, 4, 5, 6, 7, 8]);
    const pulses = await Promise.all(generations.map((generation) => heartbeatUnitLease(db, 'U-same-storm', 'agent:alpha', generation, T0 + 1, 30_000)));
    assert.deepEqual(pulses, [false, false, false, false, false, false, false, true]);
  } finally { await close(); }
});

test('heartbeat reports its own successful mutation when a newer heartbeat overtakes its response', async () => {
  const { db, close } = await start();
  const first = gateFirstMutation(db, 'after');
  try {
    const claim = await claimUnitLease(db, 'U-pulse', 'agent:alpha', T0, 30_000);
    const generation = claim.lease!.generation;
    const pending = heartbeatUnitLease(first.db, 'U-pulse', 'agent:alpha', generation, T0 + 1, 30_000);
    await first.reached;
    assert.equal(await heartbeatUnitLease(db, 'U-pulse', 'agent:alpha', generation, T0 + 2, 30_000), true);
    first.resume();
    assert.equal(await pending, true, 'success belongs to the statement, not a later readback');
    assert.equal((await getUnitLease(db, 'U-pulse'))?.heartbeat_at, T0 + 2);
  } finally { first.resume(); await close(); }
});

test('release reports its own successful mutation when the next claim overtakes its response', async () => {
  const { db, close } = await start();
  const first = gateFirstMutation(db, 'after');
  try {
    const claim = await claimUnitLease(db, 'U-release', 'agent:alpha', T0, 30_000);
    const pending = releaseUnitLease(first.db, 'U-release', 'agent:alpha', claim.lease!.generation);
    await first.reached;
    const successor = await claimUnitLease(db, 'U-release', 'agent:alpha', T0 + 1, 30_000);
    first.resume();
    assert.equal(await pending, true);
    assert.equal(successor.lease?.generation, 2);
    assert.equal((await getUnitLease(db, 'U-release'))?.state, 'held');
  } finally { first.resume(); await close(); }
});

test('repeat release reports no mutation when that generation was already released', async () => {
  const { db, close } = await start();
  try {
    const claim = await claimUnitLease(db, 'U-repeat-release', 'agent:alpha', T0, 30_000);
    assert.equal(await releaseUnitLease(db, 'U-repeat-release', 'agent:alpha', claim.lease!.generation), true);
    assert.equal(await releaseUnitLease(db, 'U-repeat-release', 'agent:alpha', claim.lease!.generation), false);
  } finally { await close(); }
});

test('sweep reports only rows it actually expires after a concurrent reclaim', async () => {
  const { db, close } = await start();
  const first = gateFirstMutation(db, 'before');
  try {
    await claimUnitLease(db, 'U-sweep-race', 'agent:alpha', T0, 1_000);
    const pending = sweepExpiredUnitLeases(first.db, T0 + 1_001);
    await first.reached;
    await claimUnitLease(db, 'U-sweep-race', 'agent:beta', T0 + 1_001, 30_000);
    first.resume();
    assert.deepEqual(await pending, []);
    assert.equal((await getUnitLease(db, 'U-sweep-race'))?.holder, 'agent:beta');
  } finally { first.resume(); await close(); }
});

test('non-integral or overflowing clock, ttl and generation inputs reject without writes', async () => {
  const { db, close } = await start();
  try {
    for (const nowMs of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(() => claimUnitLease(db, 'U-invalid', 'agent:alpha', nowMs, 1));
      await assert.rejects(() => heartbeatUnitLease(db, 'U-invalid', 'agent:alpha', 1, nowMs, 1));
      await assert.rejects(() => sweepExpiredUnitLeases(db, nowMs));
    }
    for (const ttlMs of [NaN, Infinity, -1, 0, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(() => claimUnitLease(db, 'U-invalid', 'agent:alpha', T0, ttlMs));
      await assert.rejects(() => heartbeatUnitLease(db, 'U-invalid', 'agent:alpha', 1, T0, ttlMs));
    }
    await assert.rejects(() => claimUnitLease(db, 'U-invalid', 'agent:alpha', Number.MAX_SAFE_INTEGER, 1));
    await assert.rejects(() => heartbeatUnitLease(db, 'U-invalid', 'agent:alpha', 1, Number.MAX_SAFE_INTEGER, 1));
    for (const generation of [NaN, Infinity, 0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(() => heartbeatUnitLease(db, 'U-invalid', 'agent:alpha', generation, T0, 1));
      await assert.rejects(() => releaseUnitLease(db, 'U-invalid', 'agent:alpha', generation));
    }
    assert.equal(await rows(db), 0);
  } finally { await close(); }
});

test('generation exhaustion refuses a claim instead of issuing an unsafe fencing token', async () => {
  const { db, close } = await start();
  try {
    await claimUnitLease(db, 'U-exhausted', 'agent:alpha', T0, 30_000);
    await db.prepare('UPDATE unit_leases SET generation=? WHERE unit_id=?')
      .bind(Number.MAX_SAFE_INTEGER, 'U-exhausted').all();
    const outcome = await claimUnitLease(db, 'U-exhausted', 'agent:alpha', T0 + 1, 30_000);
    assert.equal(outcome.acquired, false);
    assert.equal((await getUnitLease(db, 'U-exhausted'))?.generation, Number.MAX_SAFE_INTEGER);
  } finally { await close(); }
});
