import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import { migrate } from '../scripts/local-harness.ts';
import type { Database } from '../src/server/db.ts';
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
    for (let i = 1; i <= 3; i++) {
      const retry = await claimUnitLease(db, 'U2', 'agent:alpha', T0 + i * 1000, 30_000);
      assert.equal(retry.acquired, true, 'retry ' + i);
      assert.equal(retry.fresh, false, 'retry ' + i + ' is a refresh, not a takeover');
      assert.equal(retry.lease?.lease_until, T0 + i * 1000 + 30_000);
    }
    assert.equal(await rows(db), 1);
  } finally { await close(); }
});

test('expiry + reclaim: the stale holder is fenced out of heartbeat and release', async () => {
  const { db, close } = await start();
  try {
    await claimUnitLease(db, 'U3', 'agent:alpha', T0, 1_000);
    // Alpha crashes: no heartbeat. The lease lapses and beta takes over.
    const b = await claimUnitLease(db, 'U3', 'agent:beta', T0 + 1_001, 30_000);
    assert.equal(b.acquired, true);
    assert.equal(b.fresh, true);
    // Alpha restarts with stale state and tries to act on the lease it lost.
    assert.equal(await heartbeatUnitLease(db, 'U3', 'agent:alpha', T0 + 1_002, 30_000), false);
    assert.equal(await releaseUnitLease(db, 'U3', 'agent:alpha'), false);
    const lease = await getUnitLease(db, 'U3');
    assert.equal(lease?.holder, 'agent:beta');
    assert.equal(lease?.state, 'held');
    assert.equal(leaseLive(lease, T0 + 1_002), true);
  } finally { await close(); }
});

test('heartbeat extends a live lease and keeps rivals out past the original expiry', async () => {
  const { db, close } = await start();
  try {
    await claimUnitLease(db, 'U4', 'agent:alpha', T0, 1_000);
    assert.equal(await heartbeatUnitLease(db, 'U4', 'agent:alpha', T0 + 500, 1_000), true);
    const b = await claimUnitLease(db, 'U4', 'agent:beta', T0 + 1_200, 30_000);
    assert.equal(b.acquired, false);
    // A non-holder heartbeat never extends anything.
    assert.equal(await heartbeatUnitLease(db, 'U4', 'agent:beta', T0 + 1_300, 99_000), false);
    const lease = await getUnitLease(db, 'U4');
    assert.equal(lease?.lease_until, T0 + 1_500);
  } finally { await close(); }
});

test('an expired lease cannot be revived by heartbeat; the holder must re-claim', async () => {
  const { db, close } = await start();
  try {
    await claimUnitLease(db, 'U5', 'agent:alpha', T0, 1_000);
    assert.equal(await heartbeatUnitLease(db, 'U5', 'agent:alpha', T0 + 1_500, 1_000), false);
    const again = await claimUnitLease(db, 'U5', 'agent:alpha', T0 + 1_500, 1_000);
    assert.equal(again.acquired, true);
    assert.equal(again.fresh, true);
  } finally { await close(); }
});

test('release frees the unit at once and only the holder can release', async () => {
  const { db, close } = await start();
  try {
    await claimUnitLease(db, 'U6', 'agent:alpha', T0, 30_000);
    assert.equal(await releaseUnitLease(db, 'U6', 'agent:beta'), false);
    assert.equal(await releaseUnitLease(db, 'U6', 'agent:alpha'), true);
    const b = await claimUnitLease(db, 'U6', 'agent:beta', T0 + 1, 30_000);
    assert.equal(b.acquired, true);
    assert.equal(b.fresh, true);
    // Releasing twice is a no-op, not an error (idempotent teardown).
    assert.equal(await releaseUnitLease(db, 'U6', 'agent:alpha'), false);
  } finally { await close(); }
});

test('sweep labels only held-and-expired rows and is itself idempotent', async () => {
  const { db, close } = await start();
  try {
    await claimUnitLease(db, 'U7a', 'agent:alpha', T0, 1_000);
    await claimUnitLease(db, 'U7b', 'agent:beta', T0, 60_000);
    await claimUnitLease(db, 'U7c', 'agent:alpha', T0, 1_000);
    await releaseUnitLease(db, 'U7c', 'agent:alpha');
    assert.deepEqual(await sweepExpiredUnitLeases(db, T0 + 2_000), ['U7a']);
    assert.equal((await getUnitLease(db, 'U7a'))?.state, 'expired');
    assert.equal((await getUnitLease(db, 'U7b'))?.state, 'held');
    assert.equal((await getUnitLease(db, 'U7c'))?.state, 'released');
    assert.deepEqual(await sweepExpiredUnitLeases(db, T0 + 2_000), []);
  } finally { await close(); }
});

test('chaos restart: a restarted holder keeps fencing by holder id alone', async () => {
  const { db, close } = await start();
  try {
    // Holder process claims, then "restarts": no in-memory state survives,
    // the same holder id heartbeats from a cold start and still owns it.
    await claimUnitLease(db, 'U8', 'agent:alpha', T0, 5_000);
    assert.equal(await heartbeatUnitLease(db, 'U8', 'agent:alpha', T0 + 4_000, 5_000), true);
    const b = await claimUnitLease(db, 'U8', 'agent:beta', T0 + 8_500, 30_000);
    assert.equal(b.acquired, false);
    // Alpha finally dies for real; after the extended expiry beta takes over.
    const b2 = await claimUnitLease(db, 'U8', 'agent:beta', T0 + 9_001, 30_000);
    assert.equal(b2.acquired, true);
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
