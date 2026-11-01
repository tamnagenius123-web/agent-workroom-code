import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { migrate } from '../scripts/local-harness.ts';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import { Fault } from '../src/server/contracts.ts';
import { proposeItem, proposePromotion, proposeSupersede, promotionChain, validView, type ProposeItemInput } from '../src/server/memory-items.ts';
import { edgeContentDigest, itemContentDigest, reviewEdge, reviewItem } from '../src/server/memory-review.ts';
import type { EdgeCanonFields, ItemCanonFields } from '../src/server/canonical.ts';
import { contextPack } from '../src/server/context-pack.ts';
import type { Database } from '../src/server/db.ts';

// OCG-W W7: one-step tier promotion with the P3 guard (migration 0016).
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
    db.prepare("INSERT INTO rooms(id) VALUES ('room_other')"),
    db.prepare("INSERT INTO principals(id) VALUES ('agent:grok')"),
    db.prepare("INSERT INTO principals(id) VALUES ('agent:dots')"),
    db.prepare("INSERT INTO principals(id) VALUES ('agent:muse')"),
    db.prepare("INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES ('msg-1','room_main','agent:grok','On 2026-10-01 the room agreed retention stays dry-run','text','2026-10-01T00:00:00.000Z')"),
    db.prepare("INSERT INTO memory_reviewers(principal_id, added_at) VALUES ('agent:dots','2026-10-22T00:00:00.000Z')"),
  ]);
  return { db, close: () => mf.dispose().then(d1.cleanup) };
}

const T0 = '2026-10-01T00:00:00.000Z';
const refused = (err: unknown) => err instanceof Fault && err.code === 'INVALID_INPUT';
const aborted = (re: RegExp) => (err: unknown) => err instanceof Error && re.test(err.message);

function input(over: Partial<ProposeItemInput> = {}): ProposeItemInput {
  return { room_id: 'room_main', kind: 'fact', tier: 0, title: 'Episode', body: 'Retention stays dry-run.', source_message_id: 'msg-1', valid_from: T0, ...over };
}

async function approveItem(db: Database, id: string): Promise<void> {
  const i = (await db.prepare('SELECT id, room_id, kind, tier, title, body, valid_from, source_message_id, source_version FROM memory_items WHERE id=?').bind(id).first<ItemCanonFields>())!;
  await reviewItem(db, 'agent:dots', id, 'approve', 'checked against source', await itemContentDigest(i));
}

async function approveEdge(db: Database, id: string): Promise<void> {
  const e = (await db.prepare('SELECT id, src_id, dst_id, type FROM memory_edges WHERE id=?').bind(id).first<EdgeCanonFields>())!;
  await reviewEdge(db, 'agent:dots', id, 'approve', 'one-step promotion ok', await edgeContentDigest(e));
}

test('W7 promotion keeps valid_from, window, kind and source; source stays valid (P3)', async () => {
  const { db, close } = await start();
  try {
    const l0 = await proposeItem(db, 'agent:grok', input({ valid_until: '2026-12-01T00:00:00.000Z' }));
    await approveItem(db, l0.id);
    const p = await proposePromotion(db, 'agent:grok', { from_id: l0.id, title: 'Fact', body: 'R8 retention is dry-run by default.' });
    assert.equal(p.item.tier, 1);
    assert.equal(p.item.kind, 'fact');
    assert.equal(p.item.valid_from, T0);
    assert.equal(p.item.valid_until, '2026-12-01T00:00:00.000Z');
    assert.equal(p.item.source_message_id, 'msg-1');
    assert.equal(p.item.review_state, 'pending');
    assert.deepEqual([p.edge.type, p.edge.src_id, p.edge.dst_id, p.edge.review_state], ['PROMOTED_FROM', p.item.id, l0.id, 'pending']);
    assert.deepEqual(await promotionChain(db, p.item.id), [p.item.id, l0.id]);
    // Item cannot be approved before its edge.
    await assert.rejects(approveItem(db, p.item.id), aborted(/PROMOTED_FROM edge before|ABORT|not stored/i));
    await approveEdge(db, p.edge.id);
    await approveItem(db, p.item.id);
    const at = '2026-10-23T00:00:00.000Z';
    const view = await validView(db, 'room_main', { at });
    // Approving PROMOTED_FROM closes nothing: both the source and the promoted item are valid.
    assert.deepEqual(view.map(i => [i.id, i.tier, i.valid_until]).sort(), [[l0.id, 0, '2026-12-01T00:00:00.000Z'], [p.item.id, 1, '2026-12-01T00:00:00.000Z']].sort());
    // The context pack still carries the raw source excerpt with the promoted fact.
    const pack = await contextPack(db, 'room_main', 'retention dry-run', 4000, at);
    const fact = pack.sections.facts.find(e => e.id === p.item.id)!;
    assert.equal(fact.valid_from, T0);
    assert.match(fact.source_excerpt, /2026-10-01 the room agreed/);
  } finally { await close(); }
});

test('W7 refuses unapproved sources, skipping tiers, non-skill tier 3 and duplicate open promotions', async () => {
  const { db, close } = await start();
  try {
    const pending = await proposeItem(db, 'agent:grok', input());
    await assert.rejects(proposePromotion(db, 'agent:grok', { from_id: pending.id, title: 't', body: 'b' }), refused);
    await approveItem(db, pending.id);
    const first = await proposePromotion(db, 'agent:grok', { from_id: pending.id, title: 't', body: 'b' });
    await assert.rejects(proposePromotion(db, 'agent:muse', { from_id: pending.id, title: 't2', body: 'b2' }), refused);
    // A failed promotion leaves no orphan item behind (single batch).
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM memory_items').first<{ n: number }>())!.n, 2);
    await approveEdge(db, first.edge.id); await approveItem(db, first.item.id);
    const l2 = await proposePromotion(db, 'agent:grok', { from_id: first.item.id, title: 'certified', body: 'b' });
    await approveEdge(db, l2.edge.id); await approveItem(db, l2.item.id);
    assert.equal(l2.item.tier, 2);
    await assert.rejects(proposePromotion(db, 'agent:grok', { from_id: l2.item.id, title: 'skill?', body: 'b' }), refused);
    // A skill can reach tier 3, and the chain walks back to the episode.
    const s0 = await proposeItem(db, 'agent:grok', input({ kind: 'skill', tier: 2, title: 'skill draft' }));
    await approveItem(db, s0.id);
    const s3 = await proposePromotion(db, 'agent:grok', { from_id: s0.id, title: 'skill', body: 'procedure' });
    assert.equal(s3.item.tier, 3);
    await assert.rejects(proposePromotion(db, 'agent:grok', { from_id: s3.item.id, title: 'x', body: 'y' }), refused);
    assert.deepEqual(await promotionChain(db, l2.item.id), [l2.item.id, first.item.id, pending.id]);
    // Secrets are refused like W2.
    const other = await proposeItem(db, 'agent:grok', input({ title: 'other' }));
    await approveItem(db, other.id);
    await assert.rejects(proposePromotion(db, 'agent:grok', { from_id: other.id, title: 't', body: 'token=' + 'a'.repeat(48) }), refused);
  } finally { await close(); }
});

test('W7 triggers refuse a date-lossy or tier-skipping PROMOTED_FROM edge written directly', async () => {
  const { db, close } = await start();
  try {
    const src = await proposeItem(db, 'agent:grok', input());
    await approveItem(db, src.id);
    const lossy = await proposeItem(db, 'agent:grok', input({ tier: 1, valid_from: '2026-10-22T00:00:00.000Z', title: 'lossy' }));
    const skip = await proposeItem(db, 'agent:grok', input({ tier: 2, title: 'skip' }));
    const edge = (dst: string, srcId: string) => db.prepare("INSERT INTO memory_edges(id,src_id,dst_id,type,proposed_by,review_state,created_at) VALUES (?,?,?,'PROMOTED_FROM','agent:grok','pending','2026-10-23T00:00:00.000Z')").bind(webcrypto.randomUUID(), srcId, dst).all();
    await assert.rejects(edge(src.id, lossy.id), aborted(/promotion must be/));
    await assert.rejects(edge(src.id, skip.id), aborted(/promotion must be/));
  } finally { await close(); }
});

test('W7 memory items and edges are immutable and append-only once migration 0016 is applied', async () => {
  const { db, close } = await start();
  try {
    const a = await proposeItem(db, 'agent:grok', input());
    await approveItem(db, a.id);
    // Editing approved content in place would let a changed revision inherit verification.
    for (const sql of ["UPDATE memory_items SET body='edited' WHERE id=?", "UPDATE memory_items SET valid_from='2026-10-22T00:00:00.000Z' WHERE id=?", "UPDATE memory_items SET tier=2 WHERE id=?", "DELETE FROM memory_items WHERE id=?"]) {
      await assert.rejects(db.prepare(sql).bind(a.id).all(), aborted(/immutable|append-only/));
    }
    // Supersede approval still closes the old item once (valid_until NULL -> value), then it is frozen.
    const b = await proposeItem(db, 'agent:grok', input({ title: 'newer', valid_from: '2026-10-10T00:00:00.000Z' }));
    await approveItem(db, b.id);
    const sup = await proposeSupersede(db, 'agent:grok', a.id, b.id);
    await approveEdge(db, sup.id);
    const closed = await db.prepare('SELECT valid_until FROM memory_items WHERE id=?').bind(a.id).first<{ valid_until: string }>();
    assert.equal(closed!.valid_until, '2026-10-10T00:00:00.000Z');
    await assert.rejects(db.prepare("UPDATE memory_items SET valid_until=NULL WHERE id=?").bind(a.id).all(), aborted(/immutable/));
    await assert.rejects(db.prepare("UPDATE memory_edges SET dst_id=? WHERE id=?").bind(a.id, sup.id).all(), aborted(/immutable/));
    await assert.rejects(db.prepare('DELETE FROM memory_edges WHERE id=?').bind(sup.id).all(), aborted(/append-only/));
  } finally { await close(); }
});
