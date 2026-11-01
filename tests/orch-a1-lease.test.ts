import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { claim, expire, heartbeat, release, type ClaimResult, type UnitLease } from '../src/orch/lease.ts';
import type { Database } from '../src/server/db.ts';

const MIGRATION = 'migrations/0077_unit_leases.sql';

function applySql(db: Database, sql: string): Promise<unknown> {
  const statements = sql.trim().split(/;\s*\n/).filter(statement => statement.trim()).map(statement => db.prepare(statement));
  return db.batch(statements);
}

async function open(): Promise<{ db: Database; close: () => Promise<void> }> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response(null) } }',
    compatibilityDate: '2026-07-28',
    d1Databases: { DB: 'orch-a1-' + crypto.randomUUID() },
    cf: false,
  } as ConstructorParameters<typeof Miniflare>[0]);
  await mf.ready;
  const db = await mf.getD1Database('DB') as Database;
  await applySql(db, await readFile(MIGRATION, 'utf8'));
  return { db, close: () => mf.dispose() };
}

function readLease(db: Database, unit: string): Promise<UnitLease | null> {
  return db.prepare('SELECT unit_id, holder, lease_until, heartbeat_at, state FROM unit_leases WHERE unit_id = ?').bind(unit).first<UnitLease>();
}

function assertClaimed(result: ClaimResult, holder: string, until: number, at: number, unit: string): void {
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.lease.unit_id, unit);
  assert.equal(result.lease.holder, holder);
  assert.equal(result.lease.lease_until, until);
  assert.equal(result.lease.heartbeat_at, at);
  assert.equal(result.lease.state, 'held');
}

test('0077 unit_leases is registered used and creates the lease columns', async () => {
  const sql = await readFile(MIGRATION, 'utf8');
  for (const column of ['unit_id', 'holder', 'lease_until', 'heartbeat_at', 'state']) {
    assert.match(sql, new RegExp(`\\b${column}\\b`));
  }
  const registry = await readFile('migrations/REGISTRY.md', 'utf8');
  assert.match(registry, /^\| 0077 \| .* \| used \|$/m);
  assert.match(registry, /^merge_order:.*\b0077\b/m);
  const { db, close } = await open();
  try {
    await applySql(db, sql);
    const columns = await db.prepare("SELECT name FROM pragma_table_info('unit_leases') ORDER BY cid").all<{ name: string }>();
    assert.deepEqual(columns.results.map(column => column.name), ['unit_id', 'holder', 'lease_until', 'heartbeat_at', 'state']);
  } finally {
    await close();
  }
});

test('double-claim is rejected while the lease is held', async () => {
  const { db, close } = await open();
  try {
    const unit = 'ORCH-A1';
    const first = await claim(db, unit, 'holder-a', 10_000, 1_000_000);
    assertClaimed(first, 'holder-a', 1_010_000, 1_000_000, unit);
    const second = await claim(db, unit, 'holder-b', 10_000, 1_001_000);
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.reason, 'held');
    assert.equal(second.lease.holder, 'holder-a');
    assert.equal(second.lease.lease_until, 1_010_000);
    const same = await claim(db, unit, 'holder-a', 10_000, 1_002_000);
    assert.equal(same.ok, false);
    if (!same.ok) assert.equal(same.lease.holder, 'holder-a');
    const other = await claim(db, 'ORCH-other', 'holder-b', 10_000, 1_002_000);
    assertClaimed(other, 'holder-b', 1_012_000, 1_002_000, 'ORCH-other');
    const stored = await readLease(db, unit);
    assert.equal(stored?.holder, 'holder-a');
    assert.equal(stored?.state, 'held');
    assert.equal(stored?.lease_until, 1_010_000);
  } finally {
    await close();
  }
});

test('two concurrent claims leave a single holder', async () => {
  const { db, close } = await open();
  try {
    const unit = 'ORCH-A1';
    const [left, right] = await Promise.all([
      claim(db, unit, 'holder-a', 10_000, 2_000_000),
      claim(db, unit, 'holder-b', 10_000, 2_000_000),
    ]);
    const results = [left, right];
    assert.equal(results.filter(result => result.ok).length, 1);
    const winner = left.ok ? left : right;
    const loser = left.ok ? right : left;
    assert.equal(winner.ok, true);
    assert.equal(loser.ok, false);
    if (!winner.ok || loser.ok) return;
    assert.equal(loser.reason, 'held');
    assert.equal(loser.lease.holder, winner.lease.holder);
    const stored = await readLease(db, unit);
    assert.equal(stored?.holder, winner.lease.holder);
    assert.equal(stored?.state, 'held');
    assert.equal(stored?.lease_until, 2_010_000);
  } finally {
    await close();
  }
});

test('an expired lease is reclaimable', async () => {
  const { db, close } = await open();
  try {
    const unit = 'ORCH-A1';
    const first = await claim(db, unit, 'holder-a', 5_000, 1_000_000);
    assertClaimed(first, 'holder-a', 1_005_000, 1_000_000, unit);
    const early = await claim(db, unit, 'holder-b', 5_000, 1_004_999);
    assert.equal(early.ok, false);
    if (!early.ok) assert.equal(early.lease.holder, 'holder-a');
    const reclaimed = await claim(db, unit, 'holder-b', 8_000, 1_005_000);
    assertClaimed(reclaimed, 'holder-b', 1_013_000, 1_005_000, unit);
    const stored = await readLease(db, unit);
    assert.equal(stored?.holder, 'holder-b');
    assert.equal(stored?.state, 'held');
    assert.equal(stored?.lease_until, 1_013_000);
    assert.equal(stored?.heartbeat_at, 1_005_000);
  } finally {
    await close();
  }
});

test('heartbeat extends lease_until and heartbeat_at', async () => {
  const { db, close } = await open();
  try {
    const unit = 'ORCH-A1';
    const first = await claim(db, unit, 'holder-a', 10_000, 1_000_000);
    assertClaimed(first, 'holder-a', 1_010_000, 1_000_000, unit);
    const beat = await heartbeat(db, unit, 'holder-a', 20_000, 1_005_000);
    assert.equal(beat.ok, true);
    if (!beat.ok) return;
    assert.equal(beat.lease.holder, 'holder-a');
    assert.equal(beat.lease.state, 'held');
    assert.equal(beat.lease.heartbeat_at, 1_005_000);
    assert.equal(beat.lease.lease_until, 1_025_000);
    assert.ok(beat.lease.lease_until > 1_010_000);
    const denied = await heartbeat(db, unit, 'holder-b', 20_000, 1_006_000);
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.reason, 'not_holder');
    const afterDeny = await readLease(db, unit);
    assert.equal(afterDeny?.lease_until, 1_025_000);
    assert.equal(afterDeny?.heartbeat_at, 1_005_000);
    const stale = await heartbeat(db, unit, 'holder-a', 20_000, 1_025_000);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.reason, 'not_held');
    const afterStale = await readLease(db, unit);
    assert.equal(afterStale?.lease_until, 1_025_000);
    assert.equal(afterStale?.holder, 'holder-a');
  } finally {
    await close();
  }
});

test('release frees the unit before expiry', async () => {
  const { db, close } = await open();
  try {
    const unit = 'ORCH-A1';
    await claim(db, unit, 'holder-a', 10_000, 1_000_000);
    const denied = await release(db, unit, 'holder-b', 1_001_000);
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.reason, 'not_holder');
    const released = await release(db, unit, 'holder-a', 1_001_000);
    assert.equal(released.ok, true);
    if (!released.ok) return;
    assert.equal(released.lease.state, 'released');
    assert.equal(released.lease.holder, 'holder-a');
    const again = await release(db, unit, 'holder-a', 1_001_001);
    assert.equal(again.ok, false);
    const next = await claim(db, unit, 'holder-b', 4_000, 1_002_000);
    assertClaimed(next, 'holder-b', 1_006_000, 1_002_000, unit);
  } finally {
    await close();
  }
});

test('expire marks due held leases and leaves live ones', async () => {
  const { db, close } = await open();
  try {
    await claim(db, 'unit-due', 'holder-a', 1_000, 1_000_000);
    await claim(db, 'unit-live', 'holder-b', 9_000, 1_000_000);
    await claim(db, 'unit-dropped', 'holder-c', 1_000, 1_000_000);
    const dropped = await release(db, 'unit-dropped', 'holder-c', 1_000_100);
    assert.equal(dropped.ok, true);
    const due = await expire(db, 1_001_000);
    assert.deepEqual(due.map(row => row.unit_id).sort(), ['unit-due']);
    assert.equal(due[0]?.state, 'expired');
    assert.equal(due[0]?.holder, 'holder-a');
    assert.equal((await readLease(db, 'unit-live'))?.state, 'held');
    assert.equal((await readLease(db, 'unit-live'))?.holder, 'holder-b');
    assert.equal((await readLease(db, 'unit-dropped'))?.state, 'released');
    assert.deepEqual(await expire(db, 1_001_000), []);
    const reclaimed = await claim(db, 'unit-due', 'holder-d', 3_000, 1_001_000);
    assertClaimed(reclaimed, 'holder-d', 1_004_000, 1_001_000, 'unit-due');
  } finally {
    await close();
  }
});
