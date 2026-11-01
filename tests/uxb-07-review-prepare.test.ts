import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { migrate } from '../scripts/local-harness.ts';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import { Fault } from '../src/server/contracts.ts';
import { READ_TOOLS } from '../src/server/app.ts';
import { proposeItem, proposePromotion } from '../src/server/memory-items.ts';
import { reviewItem } from '../src/server/memory-review.ts';
import { Workroom } from '../src/server/domain.ts';
import type { Database } from '../src/server/db.ts';

// UXB-07: workroom_review_prepare returns the content and the server digest a reviewer
// echoes back on workroom_memory_review, so no client recomputes the v2 preimage.
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
    db.prepare("INSERT INTO memberships(principal_id,room_id,active,can_post) VALUES ('agent:grok','room_main',1,1)"),
    db.prepare("INSERT INTO memberships(principal_id,room_id,active,can_post) VALUES ('agent:grok','room_other',1,1)"),
    db.prepare("INSERT INTO memberships(principal_id,room_id,active,can_post) VALUES ('agent:dots','room_main',1,1)"),
    db.prepare("INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES ('msg-1','room_main','agent:grok','retention stays dry-run','text','2026-10-01T00:00:00.000Z')"),
    db.prepare("INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES ('msg-o','room_other','agent:grok','other room','text','2026-10-01T00:00:00.000Z')"),
    db.prepare("INSERT INTO memory_reviewers(principal_id, added_at) VALUES ('agent:dots','2026-10-22T00:00:00.000Z')"),
  ]);
  return { db, close: () => mf.dispose().then(d1.cleanup) };
}

const T0 = '2026-10-01T00:00:00.000Z';
const refused = (err: unknown) => err instanceof Fault && err.code === 'INVALID_INPUT';
const tamper = (hex: string) => (hex[0] === '0' ? '1' : '0') + hex.slice(1);
const item = { room_id: 'room_main', kind: 'fact' as const, tier: 0, title: 'Episode', body: 'Retention stays dry-run.', source_message_id: 'msg-1', valid_from: T0 };

test('item: review with the prepared digest passes; a tampered digest fails and stores nothing', async () => {
  const { db, close } = await start();
  try {
    const proposed = await proposeItem(db, 'agent:grok', { ...item, id: 'mi-1' });
    const dots = new Workroom(db, 'agent:dots');
    const prep = (await dots.reviewPrepare({ room: 'room_main', target: 'item', id: proposed.id })).data;
    assert.equal(prep.target, 'item');
    assert.equal(prep.id, 'mi-1');
    assert.match(prep.content_digest, /^[0-9a-f]{64}$/);
    assert.equal(prep.review_state, 'pending');
    assert.deepEqual(prep.content, { id: 'mi-1', room_id: 'room_main', kind: 'fact', tier: 0, title: 'Episode', body: 'Retention stays dry-run.', valid_from: T0, source_message_id: 'msg-1', source_version: 1 });

    await assert.rejects(dots.memoryReview({ room: 'room_main', target: 'item', id: proposed.id, verdict: 'approve', reason: 'ok', content_digest: tamper(prep.content_digest) }), refused);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM memory_reviews').first<{ n: number }>())!.n, 0);

    await dots.memoryReview({ room: 'room_main', target: 'item', id: proposed.id, verdict: 'approve', reason: 'ok', content_digest: prep.content_digest });
    assert.equal((await dots.reviewPrepare({ room: 'room_main', target: 'item', id: proposed.id })).data.review_state, 'approved');
  } finally { await close(); }
});

test('edge: review with the prepared digest passes; a tampered digest fails', async () => {
  const { db, close } = await start();
  try {
    const l0 = await proposeItem(db, 'agent:grok', { ...item, id: 'mi-l0' });
    const dots = new Workroom(db, 'agent:dots');
    const l0Prep = (await dots.reviewPrepare({ room: 'room_main', target: 'item', id: l0.id })).data;
    await reviewItem(db, 'agent:dots', l0.id, 'approve', 'ok', l0Prep.content_digest);
    const promo = await proposePromotion(db, 'agent:grok', { from_id: l0.id, title: 'Fact', body: 'Promoted wording.' });
    const prep = (await dots.reviewPrepare({ room: 'room_main', target: 'edge', id: promo.edge.id })).data;
    assert.equal(prep.target, 'edge');
    assert.deepEqual(prep.content, { id: promo.edge.id, src_id: promo.edge.src_id, dst_id: promo.edge.dst_id, type: 'PROMOTED_FROM' });
    await assert.rejects(dots.memoryReview({ room: 'room_main', target: 'edge', id: promo.edge.id, verdict: 'approve', reason: 'ok', content_digest: tamper(prep.content_digest) }), refused);
    await dots.memoryReview({ room: 'room_main', target: 'edge', id: promo.edge.id, verdict: 'approve', reason: 'ok', content_digest: prep.content_digest });
    assert.equal((await dots.reviewPrepare({ room: 'room_main', target: 'edge', id: promo.edge.id })).data.review_state, 'approved');
  } finally { await close(); }
});

test('prepare refuses unknown ids, ids from another room, and non-members', async () => {
  const { db, close } = await start();
  try {
    const theirs = await proposeItem(db, 'agent:grok', { ...item, id: 'mi-other', room_id: 'room_other', source_message_id: 'msg-o' });
    const grok = new Workroom(db, 'agent:grok');
    await assert.rejects(grok.reviewPrepare({ room: 'room_main', target: 'item', id: theirs.id }), refused);
    await assert.rejects(grok.reviewPrepare({ room: 'room_main', target: 'item', id: 'missing' }), refused);
    await assert.rejects(grok.reviewPrepare({ room: 'room_main', target: 'edge', id: 'missing' }), refused);
    await assert.rejects(new Workroom(db, 'agent:dots').reviewPrepare({ room: 'room_other', target: 'item', id: theirs.id }));
  } finally { await close(); }
});

// Dots U09 (ee326034): memory_view(include_pending=true) never returns rejected items,
// so prepare must not either. Reviews only act on pending targets.
test('prepare refuses rejected items and edges, matching memory_view(include_pending=true)', async () => {
  const { db, close } = await start();
  try {
    const dots = new Workroom(db, 'agent:dots');
    const grok = new Workroom(db, 'agent:grok');
    const bad = await proposeItem(db, 'agent:grok', { ...item, id: 'mi-bad', body: 'Rejected secret wording.' });
    const badPrep = (await dots.reviewPrepare({ room: 'room_main', target: 'item', id: bad.id })).data;
    await reviewItem(db, 'agent:dots', bad.id, 'reject', 'no', badPrep.content_digest);
    const view = (await grok.memoryView({ room: 'room_main', include_pending: true })).data.items;
    assert.ok(!view.some(i => i.id === bad.id));
    await assert.rejects(grok.reviewPrepare({ room: 'room_main', target: 'item', id: bad.id }), refused);
    await assert.rejects(dots.reviewPrepare({ room: 'room_main', target: 'item', id: bad.id }), refused);

    const l0 = await proposeItem(db, 'agent:grok', { ...item, id: 'mi-l0' });
    await reviewItem(db, 'agent:dots', l0.id, 'approve', 'ok', (await dots.reviewPrepare({ room: 'room_main', target: 'item', id: l0.id })).data.content_digest);
    const promo = await proposePromotion(db, 'agent:grok', { from_id: l0.id, title: 'Fact', body: 'Promoted wording.' });
    const edgePrep = (await dots.reviewPrepare({ room: 'room_main', target: 'edge', id: promo.edge.id })).data;
    await dots.memoryReview({ room: 'room_main', target: 'edge', id: promo.edge.id, verdict: 'reject', reason: 'no', content_digest: edgePrep.content_digest });
    await assert.rejects(grok.reviewPrepare({ room: 'room_main', target: 'edge', id: promo.edge.id }), refused);
  } finally { await close(); }
});

// Dots scoped FAIL (46bd0047): a rejected id must be indistinguishable from a missing id.
const faultOf = async (p: Promise<unknown>) => {
  try { await p; } catch (err) {
    assert.ok(err instanceof Fault);
    return { code: err.code, status: err.status, message: err.message };
  }
  assert.fail('expected a Fault');
};

test('prepare answers a rejected id exactly like a missing id', async () => {
  const { db, close } = await start();
  try {
    const dots = new Workroom(db, 'agent:dots');
    const grok = new Workroom(db, 'agent:grok');
    const bad = await proposeItem(db, 'agent:grok', { ...item, id: 'mi-bad' });
    await reviewItem(db, 'agent:dots', bad.id, 'reject', 'no', (await dots.reviewPrepare({ room: 'room_main', target: 'item', id: bad.id })).data.content_digest);
    assert.deepEqual(
      await faultOf(grok.reviewPrepare({ room: 'room_main', target: 'item', id: bad.id })),
      await faultOf(grok.reviewPrepare({ room: 'room_main', target: 'item', id: 'missing' })));

    const l0 = await proposeItem(db, 'agent:grok', { ...item, id: 'mi-l0' });
    await reviewItem(db, 'agent:dots', l0.id, 'approve', 'ok', (await dots.reviewPrepare({ room: 'room_main', target: 'item', id: l0.id })).data.content_digest);
    const promo = await proposePromotion(db, 'agent:grok', { from_id: l0.id, title: 'Fact', body: 'Promoted wording.' });
    const edgePrep = (await dots.reviewPrepare({ room: 'room_main', target: 'edge', id: promo.edge.id })).data;
    await dots.memoryReview({ room: 'room_main', target: 'edge', id: promo.edge.id, verdict: 'reject', reason: 'no', content_digest: edgePrep.content_digest });
    assert.deepEqual(
      await faultOf(grok.reviewPrepare({ room: 'room_main', target: 'edge', id: promo.edge.id })),
      await faultOf(grok.reviewPrepare({ room: 'room_main', target: 'edge', id: 'missing' })));
  } finally { await close(); }
});

test('workroom_review_prepare is a read tool', () => {
  assert.ok(READ_TOOLS.has('workroom_review_prepare'));
});
