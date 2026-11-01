import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { migrate } from '../scripts/local-harness.ts';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import { Fault } from '../src/server/contracts.ts';
import type { Database } from '../src/server/db.ts';
import { foldContentDigest, foldView, proposeFold, reviewFold, reviewFoldEdge, type FoldProposal } from '../src/server/fold.ts';
import { proposeItem, type MemoryItem } from '../src/server/memory-items.ts';
import { itemContentDigest, reviewItem } from '../src/server/memory-review.ts';
import { skillGrade } from '../src/server/skill-grade.ts';

const ROOM = 'room_main';
const FROM = '2026-10-02T00:00:00.000Z';
const NEXT = '2026-10-03T00:00:00.000Z';
const LATER = '2026-10-04T00:00:00.000Z';
const BEFORE_CLOSE = '2026-10-02T12:00:00.000Z';
const REFUSED = 'Review was not stored. The reviewer must be listed, must not be the proposer, the target must be pending, and the digest must match the content.';

function iso(ms: number): string {
  return new Date(Date.UTC(2026, 9, 1, 0, 0, 0, ms)).toISOString();
}

async function start(through = 25): Promise<{ db: Database; close: () => Promise<void> }> {
  const d1 = await cloneD1(through);
  const mf = new Miniflare({
    modules: true,
    script: 'export default { async fetch() { return new Response(null, { status: 204 }); } }',
    compatibilityDate: '2026-07-28',
    d1Databases: { DB: D1_TEMPLATE_NAME }, d1Persist: d1.dir,
    cf: false,
  } as ConstructorParameters<typeof Miniflare>[0]);
  try {
  await mf.ready;
  const db = await mf.getD1Database('DB') as Database;
  await migrate(db, through);
  await db.batch([
    db.prepare("INSERT INTO rooms(id) VALUES ('room_main')"),
    db.prepare("INSERT INTO rooms(id) VALUES ('room_other')"),
    db.prepare("INSERT INTO principals(id) VALUES ('agent:grok')"),
    db.prepare("INSERT INTO principals(id) VALUES ('agent:dots')"),
    db.prepare("INSERT INTO memory_reviewers(principal_id, added_at) VALUES ('agent:dots', '2026-10-22T00:00:00.000Z')"),
  ]);
  return { db, close: () => mf.dispose().then(d1.cleanup) };
  } catch (err) { await mf.dispose(); d1.cleanup(); throw err; }
}

async function say(db: Database, id: string, text: string, createdAt: string): Promise<void> {
  await db.prepare('INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES (?,?,?,?,?,?)')
    .bind(id, ROOM, 'agent:grok', text, 'text', createdAt).all();
}

async function roomMessages(db: Database, n: number): Promise<void> {
  for (let i = 1; i <= n; i += 1) await say(db, `m${i}`, `body ${i}`, iso(i));
}

async function countWhere(db: Database, sql: string, ...args: string[]): Promise<number> {
  const row = await db.prepare(sql).bind(...args).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

function isRefused(err: unknown): boolean {
  return err instanceof Fault && err.code === 'INVALID_INPUT' && err.message === REFUSED;
}

async function proposeSpan(db: Database, id: string, ids: string[], validFrom = FROM): Promise<FoldProposal> {
  return proposeFold(db, 'agent:grok', { id, room_id: ROOM, summary: `Summary ${id}`, valid_from: validFrom, message_ids: ids });
}

test('0022 keeps each trigger on one line', () => {
  const text = readFileSync(fileURLToPath(new URL('../migrations/0022_ocgw_fold_review.sql', import.meta.url)), 'utf8');
  assert.equal(text.endsWith(';\n'), true);
  const parts = text.trim().split(/;\s*\n/).map(part => part.trim()).filter(part => part.length > 0);
  const triggers = parts.filter(part => part.includes('CREATE TRIGGER'));
  assert.equal(triggers.length, 2);
  for (const trigger of triggers) {
    assert.equal(trigger.includes('\n'), false);
    assert.equal(trigger.replace(/;$/, '').endsWith('END'), true);
  }
});

test('unlisted, proposer, and a wrong digest store nothing; a listed reviewer can approve once', async () => {
  const { db, close } = await start();
  try {
    await roomMessages(db, 25);
    await db.prepare("INSERT INTO principals(id) VALUES ('agent:other')").all();
    const proposed = await proposeSpan(db, 'fold-ok', ['m1', 'm2']);
    const rejected = await proposeSpan(db, 'fold-no', ['m3']);
    assert.equal(proposed.fold.review_state, 'pending');
    await assert.rejects(() => reviewFold(db, 'agent:other', ROOM, 'fold-ok', 'approve', 'No.', proposed.content_digest), isRefused);
    await db.prepare("INSERT INTO memory_reviewers(principal_id, added_at) VALUES ('agent:grok', '2026-10-22T00:00:00.000Z')").all();
    await assert.rejects(() => reviewFold(db, 'agent:grok', ROOM, 'fold-ok', 'approve', 'Self.', proposed.content_digest), isRefused);
    await assert.rejects(() => reviewFold(db, 'agent:dots', ROOM, 'fold-ok', 'approve', 'Wrong.', 'ab'.repeat(32)), isRefused);
    assert.equal(await countWhere(db, 'SELECT count(*) AS n FROM memory_reviews WHERE target_id=?', 'fold-ok'), 0);
    const still = await db.prepare('SELECT review_state, summary FROM memory_folds WHERE id=?').bind('fold-ok').first<{ review_state: string; summary: string }>();
    assert.equal(still?.review_state, 'pending');
    assert.equal(still?.summary, proposed.fold.summary);

    const approved = await reviewFold(db, 'agent:dots', ROOM, 'fold-ok', 'approve', 'Recorded.', proposed.content_digest);
    assert.equal(approved.review_state, 'approved');
    assert.equal(approved.summary, 'Summary fold-ok');
    const sources = await db.prepare('SELECT message_id, source_version, source_hash, source_seq FROM fold_sources WHERE fold_id=? ORDER BY source_seq').bind('fold-ok').all<{ message_id: string; source_version: number; source_hash: string; source_seq: number }>();
    assert.deepEqual(sources.results.map(row => row.message_id), proposed.sources.map(source => source.message_id));
    assert.deepEqual(sources.results.map(row => row.source_hash), proposed.sources.map(source => source.source_hash));
    const digest = await foldContentDigest({
      id: approved.id, room_id: approved.room_id, summary: approved.summary,
      first_message_id: approved.first_message_id, last_message_id: approved.last_message_id,
      span_from: approved.span_from, span_to: approved.span_to, valid_from: approved.valid_from,
      sources: proposed.sources.map(source => ({
        message_id: source.message_id, source_version: source.source_version, source_hash: source.source_hash, source_seq: source.source_seq,
      })),
      children: [],
    });
    assert.equal(approved.content_digest, digest);
    assert.equal(approved.content_digest, proposed.content_digest);
    const reviews = await countWhere(db, 'SELECT count(*) AS n FROM memory_reviews WHERE target_id=?', 'fold-ok');
    await assert.rejects(() => reviewFold(db, 'agent:dots', ROOM, 'fold-ok', 'approve', 'Again.', proposed.content_digest), isRefused);
    assert.equal(await countWhere(db, 'SELECT count(*) AS n FROM memory_reviews WHERE target_id=?', 'fold-ok'), reviews);

    await reviewFold(db, 'agent:dots', ROOM, 'fold-no', 'reject', 'No.', rejected.content_digest);
    const view = await foldView(db, ROOM, { at: LATER });
    assert.deepEqual(view.folds.map(fold => fold.id), ['fold-ok']);
    assert.equal(view.include_pending, false);
  } finally { await close(); }
});

test('a pending supersede leaves the old fold open; approving the edge after the replacement closes the old fold (Decision S1 rev2)', async () => {
  const { db, close } = await start();
  try {
    await roomMessages(db, 25);
    const old = await proposeSpan(db, 'fold-old', ['m1', 'm2'], FROM);
    await reviewFold(db, 'agent:dots', ROOM, old.fold.id, 'approve', 'Recorded.', old.content_digest);
    const neu = await proposeFold(db, 'agent:grok', {
      id: 'fold-new', room_id: ROOM, summary: 'Replacement summary.', valid_from: NEXT, message_ids: ['m3', 'm4'], supersedes: 'fold-old',
    });
    const edge = neu.edges.find(item => item.type === 'SUPERSEDED_BY');
    assert.ok(edge);
    assert.equal(edge.src_id, 'fold-old');
    assert.equal(edge.dst_id, 'fold-new');
    assert.equal(edge.review_state, 'pending');
    const open = await db.prepare('SELECT summary, valid_until FROM memory_folds WHERE id=?').bind('fold-old').first<{ summary: string; valid_until: string | null }>();
    assert.equal(open?.valid_until, null);
    assert.equal(open?.summary, 'Summary fold-old');
    const whilePending = await foldView(db, ROOM, { at: LATER });
    assert.deepEqual(whilePending.folds.map(fold => fold.id), ['fold-old']);

    // Decision S1 rev2: on disjoint sources the replacement can be approved first; both stay open until the edge.
    await reviewFold(db, 'agent:dots', ROOM, 'fold-new', 'approve', 'Recorded.', neu.content_digest);
    const both = await foldView(db, ROOM, { at: NEXT });
    assert.deepEqual(both.folds.map(fold => fold.id).sort(), ['fold-new', 'fold-old']);

    await reviewFoldEdge(db, 'agent:dots', ROOM, edge.id, 'approve', 'Close it.', edge.content_digest);
    const closed = await db.prepare('SELECT summary, valid_until FROM memory_folds WHERE id=?').bind('fold-old').first<{ summary: string; valid_until: string | null }>();
    assert.equal(closed?.valid_until, NEXT);
    assert.equal(closed?.summary, 'Summary fold-old');
    const after = await foldView(db, ROOM, { at: NEXT });
    assert.deepEqual(after.folds.map(fold => fold.id), ['fold-new']);
    assert.equal(after.folds[0]?.summary, 'Replacement summary.');
    const earlier = await foldView(db, ROOM, { at: BEFORE_CLOSE });
    assert.deepEqual(earlier.folds.map(fold => fold.id), ['fold-old']);
  } finally { await close(); }
});

test('a rejected replacement leaves the old fold open and its supersede edge unapprovable', async () => {
  const { db, close } = await start();
  try {
    await roomMessages(db, 25);
    const old = await proposeSpan(db, 'fold-old', ['m1', 'm2'], FROM);
    await reviewFold(db, 'agent:dots', ROOM, old.fold.id, 'approve', 'Recorded.', old.content_digest);
    const neu = await proposeFold(db, 'agent:grok', {
      id: 'fold-new', room_id: ROOM, summary: 'Replacement summary.', valid_from: NEXT, message_ids: ['m3', 'm4'], supersedes: 'fold-old',
    });
    const edge = neu.edges.find(item => item.type === 'SUPERSEDED_BY');
    assert.ok(edge);
    await reviewFold(db, 'agent:dots', ROOM, 'fold-new', 'reject', 'No.', neu.content_digest);
    await assert.rejects(() => reviewFoldEdge(db, 'agent:dots', ROOM, edge.id, 'approve', 'Close it.', edge.content_digest),
      (err: unknown) => err instanceof Fault && err.code === 'INVALID_INPUT');
    await reviewFoldEdge(db, 'agent:dots', ROOM, edge.id, 'reject', 'Replacement rejected.', edge.content_digest);
    const view = await foldView(db, ROOM, { at: LATER });
    assert.deepEqual(view.folds.map(fold => fold.id), ['fold-old']);
  } finally { await close(); }
});

test('same-span replacement: an armed edge closes the old fold atomically when the replacement is approved (HOLD d0792c2)', async () => {
  const { db, close } = await start();
  try {
    await roomMessages(db, 25);
    const old = await proposeSpan(db, 'fold-old', ['m1', 'm2'], FROM);
    await reviewFold(db, 'agent:dots', ROOM, old.fold.id, 'approve', 'Recorded.', old.content_digest);
    const neu = await proposeFold(db, 'agent:grok', {
      id: 'fold-new', room_id: ROOM, summary: 'Replacement summary.', valid_from: NEXT, message_ids: ['m1', 'm2'], supersedes: 'fold-old',
    });
    const edge = neu.edges.find(item => item.type === 'SUPERSEDED_BY');
    assert.ok(edge);

    // Replacement first is refused by coverage while the edge is not armed, and stores nothing.
    const before = await countWhere(db, 'SELECT count(*) AS n FROM memory_reviews WHERE target_id=?', 'fold-new');
    await assert.rejects(() => reviewFold(db, 'agent:dots', ROOM, 'fold-new', 'approve', 'Too early.', neu.content_digest),
      (err: unknown) => err instanceof Fault && err.code === 'INVALID_INPUT');
    assert.equal(await countWhere(db, 'SELECT count(*) AS n FROM memory_reviews WHERE target_id=?', 'fold-new'), before);

    // Arming the edge while the replacement is pending leaves the old fold open: no empty interval.
    const armed = await reviewFoldEdge(db, 'agent:dots', ROOM, edge.id, 'approve', 'Arm.', edge.content_digest);
    assert.equal(armed.review_state, 'approved');
    const open = await db.prepare('SELECT valid_until FROM memory_folds WHERE id=?').bind('fold-old').first<{ valid_until: string | null }>();
    assert.equal(open?.valid_until, null);
    assert.deepEqual((await foldView(db, ROOM, { at: LATER })).folds.map(fold => fold.id), ['fold-old']);

    // Approving the replacement closes the old fold at its valid_from in the same batch.
    await reviewFold(db, 'agent:dots', ROOM, 'fold-new', 'approve', 'Recorded.', neu.content_digest);
    const closed = await db.prepare('SELECT summary, valid_until FROM memory_folds WHERE id=?').bind('fold-old').first<{ summary: string; valid_until: string | null }>();
    assert.equal(closed?.valid_until, NEXT);
    assert.equal(closed?.summary, 'Summary fold-old');
    assert.deepEqual((await foldView(db, ROOM, { at: NEXT })).folds.map(fold => fold.id), ['fold-new']);
    assert.deepEqual((await foldView(db, ROOM, { at: BEFORE_CLOSE })).folds.map(fold => fold.id), ['fold-old']);
  } finally { await close(); }
});

test('same-span replacement: rejecting it after the edge is armed keeps the old fold open; a rejected replacement cannot be armed', async () => {
  const { db, close } = await start();
  try {
    await roomMessages(db, 25);
    const old = await proposeSpan(db, 'fold-old', ['m1', 'm2'], FROM);
    await reviewFold(db, 'agent:dots', ROOM, old.fold.id, 'approve', 'Recorded.', old.content_digest);
    const neu = await proposeFold(db, 'agent:grok', {
      id: 'fold-new', room_id: ROOM, summary: 'Replacement summary.', valid_from: NEXT, message_ids: ['m1', 'm2'], supersedes: 'fold-old',
    });
    const edge = neu.edges.find(item => item.type === 'SUPERSEDED_BY');
    assert.ok(edge);
    await reviewFoldEdge(db, 'agent:dots', ROOM, edge.id, 'approve', 'Arm.', edge.content_digest);
    await reviewFold(db, 'agent:dots', ROOM, 'fold-new', 'reject', 'No.', neu.content_digest);
    const open = await db.prepare('SELECT valid_until FROM memory_folds WHERE id=?').bind('fold-old').first<{ valid_until: string | null }>();
    assert.equal(open?.valid_until, null);
    assert.deepEqual((await foldView(db, ROOM, { at: LATER })).folds.map(fold => fold.id), ['fold-old']);

    const again = await proposeFold(db, 'agent:grok', {
      id: 'fold-new2', room_id: ROOM, summary: 'Second try.', valid_from: NEXT, message_ids: ['m1', 'm2'], supersedes: 'fold-old',
    });
    const edge2 = again.edges.find(item => item.type === 'SUPERSEDED_BY');
    assert.ok(edge2);
    await reviewFold(db, 'agent:dots', ROOM, 'fold-new2', 'reject', 'No.', again.content_digest);
    await assert.rejects(() => reviewFoldEdge(db, 'agent:dots', ROOM, edge2.id, 'approve', 'Arm.', edge2.content_digest),
      (err: unknown) => err instanceof Fault && err.code === 'INVALID_INPUT');
    await assert.rejects(() => db.prepare("UPDATE fold_edges SET review_state='approved' WHERE id=?").bind(edge2.id).all(), /pending or approved and open/);
  } finally { await close(); }
});

test('approving a second open span over the same message stores no review', async () => {
  const { db, close } = await start();
  try {
    await roomMessages(db, 25);
    const first = await proposeSpan(db, 'fold-a', ['m1', 'm2']);
    const second = await proposeSpan(db, 'fold-b', ['m2', 'm3']);
    await reviewFold(db, 'agent:dots', ROOM, first.fold.id, 'approve', 'Recorded.', first.content_digest);
    const before = await countWhere(db, 'SELECT count(*) AS n FROM memory_reviews WHERE target_id=?', 'fold-b');
    await assert.rejects(
      () => reviewFold(db, 'agent:dots', ROOM, second.fold.id, 'approve', 'Recorded.', second.content_digest),
      (err: unknown) => err instanceof Fault && /covered/.test(err.message),
    );
    assert.equal(await countWhere(db, 'SELECT count(*) AS n FROM memory_reviews WHERE target_id=?', 'fold-b'), before);
    const state = await db.prepare('SELECT review_state FROM memory_folds WHERE id=?').bind('fold-b').first<{ review_state: string }>();
    assert.equal(state?.review_state, 'pending');
  } finally { await close(); }
});

test('an item review written before 0022 still grades the skill', async () => {
  const { db, close } = await start(20);
  try {
    await say(db, 'msg-skill', 'skill source', FROM);
    const item: MemoryItem = await proposeItem(db, 'agent:grok', {
      id: 'skill-1', room_id: ROOM, kind: 'skill', tier: 2, title: 'Grade me', body: 'A skill body.',
      source_message_id: 'msg-skill', valid_from: FROM,
    });
    await reviewItem(db, 'agent:dots', item.id, 'approve', 'Recorded.', await itemContentDigest(item));
    assert.equal((await skillGrade(db, item.id)).letter, 'F');
    const before = await db.prepare('SELECT id, target_kind, target_id, content_digest FROM memory_reviews ORDER BY id').all<{ id: string; target_kind: string; target_id: string; content_digest: string }>();
    const beforeCount = before.results.length;
    assert.equal(beforeCount, 1);
    await migrate(db, 25);
    const after = await db.prepare('SELECT id, target_kind, target_id, content_digest FROM memory_reviews ORDER BY id').all<{ id: string; target_kind: string; target_id: string; content_digest: string }>();
    assert.equal(after.results.length, beforeCount);
    assert.deepEqual(after.results, before.results);
    assert.equal((await skillGrade(db, item.id)).letter, 'F');
    const trigger = await db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='memory_items_review_state'").first<{ name: string }>();
    assert.equal(trigger?.name, 'memory_items_review_state');
  } finally { await close(); }
});
