import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { migrate } from '../scripts/local-harness.ts';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import { Fault } from '../src/server/contracts.ts';
import { proposeItem, proposeSupersede, validView, type ProposeItemInput } from '../src/server/memory-items.ts';
import { edgeContentDigest, itemContentDigest, reviewEdge, reviewItem } from '../src/server/memory-review.ts';
import type { Database } from '../src/server/db.ts';

// Each test owns a Miniflare D1, same start/migrate shape as tests/ocgw-items.test.ts, through migration 0014.
async function start(): Promise<{ db: Database; close: () => Promise<void> }> {
  const d1 = await cloneD1(20);
  const mf = new Miniflare({
    modules: true,
    script: 'export default { async fetch() { return new Response(null, { status: 204 }); } }',
    compatibilityDate: '2026-07-28',
    d1Databases: { DB: D1_TEMPLATE_NAME }, d1Persist: d1.dir,
    cf: false,
  } as ConstructorParameters<typeof Miniflare>[0]);
  await mf.ready;
  const db = await mf.getD1Database('DB') as Database;
  await migrate(db, 20);
  await db.batch([
    db.prepare("INSERT INTO rooms(id) VALUES ('room_main')"),
    db.prepare("INSERT INTO principals(id) VALUES ('agent:grok')"),
    db.prepare("INSERT INTO principals(id) VALUES ('agent:dots')"),
    db.prepare("INSERT INTO principals(id) VALUES ('agent:muse')"),
    db.prepare("INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES ('msg-1','room_main','agent:grok','source text','text','2026-10-01T00:00:00.000Z')"),
  ]);
  return { db, close: () => mf.dispose().then(d1.cleanup) };
}

const T0 = '2026-10-01T00:00:00.000Z';
const T1 = '2026-10-20T00:00:00.000Z';
const BETWEEN = '2026-10-10T00:00:00.000Z';
const AT = '2026-10-23T00:00:00.000Z';

function input(over: Partial<ProposeItemInput> = {}): ProposeItemInput {
  return {
    room_id: 'room_main', kind: 'fact', tier: 1, title: 'A fact', body: 'The room agreed on the record.',
    source_message_id: 'msg-1', valid_from: T0, ...over,
  };
}

async function allow(db: Database, principalId: string): Promise<void> {
  await db.prepare('INSERT INTO memory_reviewers(principal_id, added_at) VALUES (?, ?)').bind(principalId, '2026-10-22T00:00:00.000Z').all();
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function refused(err: unknown): boolean {
  return err instanceof Fault && err.code === 'INVALID_INPUT';
}

test('rev2 content digests are sha256 hex of the versioned JSON item and edge preimage', async () => {
  const item = { id: 'i1', room_id: 'room_main', kind: 'fact', tier: 1, title: 'A fact', body: 'The room agreed on the record.', valid_from: T0, source_message_id: 'm1', source_version: 2 };
  assert.equal(await itemContentDigest(item), sha(JSON.stringify(['workroom.memory_item.v2', 'i1', 'room_main', 'fact', 1, 'A fact', 'The room agreed on the record.', T0, 'm1', 2])));
  assert.equal(await edgeContentDigest({ id: 'e1', src_id: 'old', dst_id: 'new', type: 'SUPERSEDED_BY' }), sha(JSON.stringify(['workroom.memory_edge.v2', 'e1', 'old', 'new', 'SUPERSEDED_BY'])));
});

test('rev2 delimiter boundaries: moving a newline or separator between fields changes the digest', async () => {
  const base = { id: 'i1', room_id: 'room_main', kind: 'fact', tier: 1, title: 'a\nb', body: 'c', valid_from: T0, source_message_id: 'm1', source_version: 1 };
  const shifted = { ...base, title: 'a', body: 'b\nc' };
  // Legacy title\nbody\nvalid_from collided here; the JSON preimage does not.
  assert.equal(`${base.title}\n${base.body}\n${T0}`, `${shifted.title}\n${shifted.body}\n${T0}`);
  assert.notEqual(await itemContentDigest(base), await itemContentDigest(shifted));
  assert.notEqual(await edgeContentDigest({ id: 'e', src_id: 'a>b', dst_id: 'c', type: 'SUPERSEDED_BY' }), await edgeContentDigest({ id: 'e', src_id: 'a', dst_id: 'b>c', type: 'SUPERSEDED_BY' }));
  assert.notEqual(await itemContentDigest(base), await itemContentDigest({ ...base, id: 'i2' }), 'identity is bound');
  assert.notEqual(await itemContentDigest(base), await itemContentDigest({ ...base, source_version: 2 }), 'evidence revision is bound');
});

test('self-approval is refused', async () => {
  const { db, close } = await start();
  try {
    assert.equal((await db.prepare('SELECT count(*) n FROM memory_reviewers').first<{ n: number }>())!.n, 0);
    await allow(db, 'agent:grok');
    const item = await proposeItem(db, 'agent:grok', input());
    const digest = await itemContentDigest(item);
    await assert.rejects(() => reviewItem(db, 'agent:grok', item.id, 'approve', 'I wrote it.', digest), refused);
    assert.equal((await db.prepare('SELECT review_state, valid_until FROM memory_items WHERE id=?').bind(item.id).first<{ review_state: string; valid_until: string | null }>())!.review_state, 'pending');
    assert.equal((await db.prepare('SELECT count(*) n FROM memory_reviews').first<{ n: number }>())!.n, 0);
    assert.deepEqual(await validView(db, 'room_main', { at: AT }), []);
  } finally { await close(); }
});

test('an unlisted reviewer is refused', async () => {
  const { db, close } = await start();
  try {
    await allow(db, 'agent:dots');
    const item = await proposeItem(db, 'agent:grok', input());
    const digest = await itemContentDigest(item);
    await assert.rejects(() => reviewItem(db, 'agent:muse', item.id, 'approve', 'Not on the list.', digest), refused);
    assert.equal((await db.prepare('SELECT review_state FROM memory_items WHERE id=?').bind(item.id).first<{ review_state: string }>())!.review_state, 'pending');
    assert.equal((await db.prepare('SELECT count(*) n FROM memory_reviews').first<{ n: number }>())!.n, 0);
  } finally { await close(); }
});

test('a wrong content digest is refused', async () => {
  const { db, close } = await start();
  try {
    await allow(db, 'agent:dots');
    const item = await proposeItem(db, 'agent:grok', input());
    const wrong = await itemContentDigest({ ...item, body: 'A different body.' });
    assert.notEqual(wrong, await itemContentDigest(item));
    await assert.rejects(() => reviewItem(db, 'agent:dots', item.id, 'approve', 'Stale read.', wrong), refused);
    const edgeItem = await proposeItem(db, 'agent:grok', input({ title: 'Other', body: 'Edge endpoint.', valid_from: T1 }));
    const edge = await proposeSupersede(db, 'agent:grok', item.id, edgeItem.id);
    const wrongEdge = await edgeContentDigest({ ...edge, src_id: edge.dst_id, dst_id: edge.src_id });
    await assert.rejects(() => reviewEdge(db, 'agent:dots', edge.id, 'approve', 'Swapped ends.', wrongEdge), refused);
    assert.equal((await db.prepare('SELECT review_state FROM memory_items WHERE id=?').bind(item.id).first<{ review_state: string }>())!.review_state, 'pending');
    assert.equal((await db.prepare('SELECT review_state FROM memory_edges WHERE id=?').bind(edge.id).first<{ review_state: string }>())!.review_state, 'pending');
    assert.equal((await db.prepare('SELECT count(*) n FROM memory_reviews').first<{ n: number }>())!.n, 0);
    assert.equal((await db.prepare('SELECT valid_until FROM memory_items WHERE id=?').bind(item.id).first<{ valid_until: string | null }>())!.valid_until, null);
  } finally { await close(); }
});

test('a direct update to approved without a review aborts', async () => {
  const { db, close } = await start();
  try {
    const item = await proposeItem(db, 'agent:grok', input());
    const other = await proposeItem(db, 'agent:grok', input({ title: 'Next', body: 'Replacement text.', valid_from: T1 }));
    const edge = await proposeSupersede(db, 'agent:grok', item.id, other.id);
    const abort = (err: unknown) => err instanceof Error && /independent listed reviewer|ABORT/i.test(err.message);
    await assert.rejects(db.prepare("UPDATE memory_items SET review_state='approved' WHERE id=?").bind(item.id).all(), abort);
    await assert.rejects(db.prepare("UPDATE memory_edges SET review_state='approved' WHERE id=?").bind(edge.id).all(), abort);
    await assert.rejects(db.prepare("UPDATE memory_items SET review_state='rejected' WHERE id=?").bind(item.id).all(), abort);
    assert.equal((await db.prepare('SELECT review_state FROM memory_items WHERE id=?').bind(item.id).first<{ review_state: string }>())!.review_state, 'pending');
    assert.equal((await db.prepare('SELECT review_state FROM memory_edges WHERE id=?').bind(edge.id).first<{ review_state: string }>())!.review_state, 'pending');
    await allow(db, 'agent:grok');
    const forged = 'ab'.repeat(32);
    await db.prepare(`INSERT INTO memory_reviews(id, target_kind, target_id, verdict, reviewer_id, reason, content_digest, created_at)
      VALUES ('self-review','item',?,'approve','agent:grok','self',?,'2026-10-22T00:00:00.000Z')`).bind(item.id, forged).all();
    await assert.rejects(db.prepare("UPDATE memory_items SET review_state='approved' WHERE id=?").bind(item.id).all(), abort);
    await db.prepare(`INSERT INTO memory_reviews(id, target_kind, target_id, verdict, reviewer_id, reason, content_digest, created_at)
      VALUES ('outsider-review','item',?,'approve','agent:muse','not listed',?,'2026-10-22T00:00:00.000Z')`).bind(item.id, forged).all();
    await assert.rejects(db.prepare("UPDATE memory_items SET review_state='approved' WHERE id=?").bind(item.id).all(), abort);
    assert.equal((await db.prepare('SELECT review_state FROM memory_items WHERE id=?').bind(item.id).first<{ review_state: string }>())!.review_state, 'pending');
    await assert.rejects(db.prepare("UPDATE memory_reviews SET reason='changed' WHERE id='self-review'").all(), (err: unknown) => err instanceof Error && /immutable review|ABORT/i.test(err.message));
    await assert.rejects(db.prepare("DELETE FROM memory_reviews WHERE id='self-review'").all(), (err: unknown) => err instanceof Error && /immutable review|ABORT/i.test(err.message));
    assert.equal((await db.prepare("SELECT reason FROM memory_reviews WHERE id='self-review'").first<{ reason: string }>())!.reason, 'self');
  } finally { await close(); }
});

test('reject records the verdict and does not close a superseded item', async () => {
  const { db, close } = await start();
  try {
    await allow(db, 'agent:dots');
    const dropped = await proposeItem(db, 'agent:grok', input({ title: 'Dropped', body: 'Reviewer said no.' }));
    const digest = await itemContentDigest(dropped);
    const rejected = await reviewItem(db, 'agent:dots', dropped.id, 'reject', 'Not a fact.', digest);
    assert.equal(rejected.review_state, 'rejected');
    assert.equal(rejected.valid_until, null);
    const review = await db.prepare('SELECT target_kind, verdict, reviewer_id, reason, content_digest FROM memory_reviews WHERE target_id=?').bind(dropped.id).first<{ target_kind: string; verdict: string; reviewer_id: string; reason: string; content_digest: string }>();
    assert.equal(review!.target_kind, 'item');
    assert.equal(review!.verdict, 'reject');
    assert.equal(review!.reviewer_id, 'agent:dots');
    assert.equal(review!.reason, 'Not a fact.');
    assert.equal(review!.content_digest, digest);
    assert.deepEqual(await validView(db, 'room_main', { at: AT }), []);
    assert.deepEqual(await validView(db, 'room_main', { at: AT, includePending: true }), []);
    const older = await proposeItem(db, 'agent:grok', input({ title: 'Old decision', kind: 'decision', tier: 2, body: 'Still current.' }));
    const newer = await proposeItem(db, 'agent:grok', input({ title: 'New decision', kind: 'decision', tier: 2, body: 'Not accepted.', valid_from: T1 }));
    await reviewItem(db, 'agent:dots', older.id, 'approve', 'Keep it.', await itemContentDigest(older));
    const edge = await proposeSupersede(db, 'agent:grok', older.id, newer.id);
    const closed = await reviewEdge(db, 'agent:dots', edge.id, 'reject', 'The old decision stands.', await edgeContentDigest(edge));
    assert.equal(closed.review_state, 'rejected');
    assert.equal((await db.prepare('SELECT valid_until, review_state FROM memory_items WHERE id=?').bind(older.id).first<{ valid_until: string | null; review_state: string }>())!.valid_until, null);
    assert.deepEqual((await validView(db, 'room_main', { at: AT })).map(item => item.id), [older.id]);
  } finally { await close(); }
});

test('approving a supersede closes the old item at the new valid_from and an earlier at still returns it', async () => {
  const { db, close } = await start();
  try {
    await allow(db, 'agent:dots');
    const older = await proposeItem(db, 'agent:grok', input({ title: 'Old decision', kind: 'decision', tier: 2, body: 'Use pending edges.', valid_from: T0 }));
    const newer = await proposeItem(db, 'agent:grok', input({ title: 'New decision', kind: 'decision', tier: 2, body: 'Close the old row only after review.', valid_from: T1 }));
    const approvedOld = await reviewItem(db, 'agent:dots', older.id, 'approve', 'Recorded.', await itemContentDigest(older));
    const approvedNew = await reviewItem(db, 'agent:dots', newer.id, 'approve', 'Recorded.', await itemContentDigest(newer));
    assert.equal(approvedOld.review_state, 'approved');
    assert.equal(approvedOld.valid_until, null);
    assert.equal(approvedNew.review_state, 'approved');
    assert.deepEqual((await validView(db, 'room_main', { at: AT })).map(item => item.id), [older.id, newer.id]);
    const edge = await proposeSupersede(db, 'agent:grok', older.id, newer.id);
    assert.equal((await db.prepare('SELECT valid_until FROM memory_items WHERE id=?').bind(older.id).first<{ valid_until: string | null }>())!.valid_until, null);
    assert.ok((await validView(db, 'room_main', { at: AT })).some(item => item.id === older.id));
    const approvedEdge = await reviewEdge(db, 'agent:dots', edge.id, 'approve', 'The new decision replaces it.', await edgeContentDigest(edge));
    assert.equal(approvedEdge.review_state, 'approved');
    assert.equal((await db.prepare('SELECT valid_until, review_state FROM memory_items WHERE id=?').bind(older.id).first<{ valid_until: string | null; review_state: string }>())!.valid_until, T1);
    assert.equal((await db.prepare('SELECT review_state FROM memory_items WHERE id=?').bind(older.id).first<{ review_state: string }>())!.review_state, 'approved');
    const after = (await validView(db, 'room_main', { at: AT })).map(item => item.id);
    assert.deepEqual(after, [newer.id]);
    const atStart = (await validView(db, 'room_main', { at: T1 })).map(item => item.id);
    assert.deepEqual(atStart, [newer.id]);
    const earlier = (await validView(db, 'room_main', { at: BETWEEN })).map(item => item.id);
    assert.deepEqual(earlier, [older.id]);
    const kept = await proposeItem(db, 'agent:grok', input({ title: 'Dated', body: 'Already closed.', valid_from: T0 }));
    const replacement = await proposeItem(db, 'agent:grok', input({ title: 'Later', body: 'Would overwrite.', valid_from: T1 }));
    await reviewItem(db, 'agent:dots', kept.id, 'approve', 'Keep the existing end.', await itemContentDigest(kept));
    const sentinel = '2026-12-01T00:00:00.000Z';
    await db.prepare('UPDATE memory_items SET valid_until=? WHERE id=?').bind(sentinel, kept.id).all();
    const second = await proposeSupersede(db, 'agent:grok', kept.id, replacement.id);
    await reviewEdge(db, 'agent:dots', second.id, 'approve', 'Do not move an existing end.', await edgeContentDigest(second));
    assert.equal((await db.prepare('SELECT valid_until FROM memory_items WHERE id=?').bind(kept.id).first<{ valid_until: string | null }>())!.valid_until, sentinel);
  } finally { await close(); }
});

test('a second review is refused', async () => {
  const { db, close } = await start();
  try {
    await allow(db, 'agent:dots');
    await allow(db, 'agent:muse');
    const item = await proposeItem(db, 'agent:grok', input());
    const digest = await itemContentDigest(item);
    const approved = await reviewItem(db, 'agent:dots', item.id, 'approve', 'Once.', digest);
    assert.equal(approved.review_state, 'approved');
    await assert.rejects(() => reviewItem(db, 'agent:muse', item.id, 'reject', 'Again.', digest), refused);
    await assert.rejects(() => reviewItem(db, 'agent:dots', item.id, 'approve', 'Again.', digest), refused);
    assert.equal((await db.prepare('SELECT review_state FROM memory_items WHERE id=?').bind(item.id).first<{ review_state: string }>())!.review_state, 'approved');
    assert.equal((await db.prepare('SELECT count(*) n FROM memory_reviews WHERE target_id=?').bind(item.id).first<{ n: number }>())!.n, 1);
    assert.deepEqual((await validView(db, 'room_main', { at: AT })).map(row => row.id), [item.id]);
    const newer = await proposeItem(db, 'agent:grok', input({ title: 'New', body: 'Successor.', valid_from: T1 }));
    await reviewItem(db, 'agent:dots', newer.id, 'approve', 'Recorded.', await itemContentDigest(newer));
    const edge = await proposeSupersede(db, 'agent:grok', item.id, newer.id);
    const edgeDigest = await edgeContentDigest(edge);
    await reviewEdge(db, 'agent:dots', edge.id, 'approve', 'Closed.', edgeDigest);
    await assert.rejects(() => reviewEdge(db, 'agent:muse', edge.id, 'reject', 'Too late.', edgeDigest), refused);
    assert.equal((await db.prepare('SELECT review_state FROM memory_edges WHERE id=?').bind(edge.id).first<{ review_state: string }>())!.review_state, 'approved');
    assert.equal((await db.prepare('SELECT count(*) n FROM memory_reviews WHERE target_id=?').bind(edge.id).first<{ n: number }>())!.n, 1);
    assert.equal((await db.prepare('SELECT valid_until FROM memory_items WHERE id=?').bind(item.id).first<{ valid_until: string | null }>())!.valid_until, T1);
  } finally { await close(); }
});
