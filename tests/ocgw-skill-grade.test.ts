import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { migrate } from '../scripts/local-harness.ts';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import { Fault } from '../src/server/contracts.ts';
import type { Database } from '../src/server/db.ts';
import { proposeItem, proposeSupersede, type ProposeItemInput } from '../src/server/memory-items.ts';
import { edgeContentDigest, itemContentDigest, reviewEdge, reviewItem } from '../src/server/memory-review.ts';
import { endorseSkill, skillGrade, type SkillGrade } from '../src/server/skill-grade.ts';

// Each test owns a Miniflare D1. W5 adds no migration: grades are a read over 0013/0014.
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
    db.prepare("INSERT INTO principals(id) VALUES ('agent:codex')"),
    db.prepare("INSERT INTO principals(id) VALUES ('agent:egg')"),
    db.prepare("INSERT INTO principals(id) VALUES ('agent:outsider')"),
    db.prepare("INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES ('msg-1','room_main','agent:grok','source text','text','2026-10-01T00:00:00.000Z')"),
  ]);
  return { db, close: () => mf.dispose().then(d1.cleanup) };
}

const T0 = '2026-10-01T00:00:00.000Z';
const T1 = '2026-10-20T00:00:00.000Z';

function skill(over: Partial<ProposeItemInput> = {}): ProposeItemInput {
  return {
    room_id: 'room_main', kind: 'skill', tier: 3, title: 'Close the loop',
    body: 'Named reviewer agent:dots. Declared grade A. chair_validated true.',
    source_message_id: 'msg-1', valid_from: T0, ...over,
  };
}

async function allow(db: Database, principalId: string): Promise<void> {
  await db.prepare('INSERT INTO memory_reviewers(principal_id, added_at) VALUES (?, ?)').bind(principalId, '2026-10-22T00:00:00.000Z').all();
}

function refused(err: unknown): boolean {
  return err instanceof Fault && err.code === 'INVALID_INPUT' && /not stored/i.test(err.message);
}

async function reviewCount(db: Database, itemId: string): Promise<number> {
  const row = await db.prepare('SELECT count(*) n FROM memory_reviews WHERE target_kind=\'item\' AND target_id=?').bind(itemId).first<{ n: number }>();
  return row!.n;
}

async function reviewId(db: Database, itemId: string, reviewerId: string): Promise<string> {
  const found = await db.prepare(`SELECT id FROM memory_reviews WHERE target_kind='item' AND target_id=? AND reviewer_id=? ORDER BY created_at, id`)
    .bind(itemId, reviewerId).all<{ id: string }>();
  assert.equal(found.results.length, 1);
  return found.results[0]!.id;
}

function sameIds(actual: readonly string[], expected: readonly string[]): void {
  assert.deepEqual([...actual].sort(), [...expected].sort());
}

test('the proposer cannot endorse their own skill', async () => {
  const { db, close } = await start();
  try {
    await allow(db, 'agent:grok');
    await allow(db, 'agent:dots');
    const item = await proposeItem(db, 'agent:grok', skill());
    const digest = await itemContentDigest(item);
    await reviewItem(db, 'agent:dots', item.id, 'approve', 'Independent pass.', digest);
    await assert.rejects(() => endorseSkill(db, 'agent:grok', item.id, 'I wrote it.', digest), refused);
    assert.equal(await reviewCount(db, item.id), 1);
    const grade = await skillGrade(db, item.id);
    assert.equal(grade.letter, 'F');
    assert.equal(grade.distinct_pass_reviewers, 1);
    assert.equal((await db.prepare('SELECT review_state FROM memory_items WHERE id=?').bind(item.id).first<{ review_state: string }>())!.review_state, 'approved');
  } finally { await close(); }
});

test('an unlisted reviewer cannot endorse a skill', async () => {
  const { db, close } = await start();
  try {
    await allow(db, 'agent:dots');
    const item = await proposeItem(db, 'agent:grok', skill());
    const digest = await itemContentDigest(item);
    await reviewItem(db, 'agent:dots', item.id, 'approve', 'Independent pass.', digest);
    await assert.rejects(() => endorseSkill(db, 'agent:outsider', item.id, 'Not on the list.', digest), refused);
    assert.equal(await reviewCount(db, item.id), 1);
    assert.equal((await skillGrade(db, item.id)).letter, 'F');
  } finally { await close(); }
});

test('a reviewer cannot endorse the same skill twice', async () => {
  const { db, close } = await start();
  try {
    await allow(db, 'agent:dots');
    await allow(db, 'agent:muse');
    const item = await proposeItem(db, 'agent:grok', skill());
    const digest = await itemContentDigest(item);
    await reviewItem(db, 'agent:dots', item.id, 'approve', 'Once.', digest);
    await assert.rejects(() => endorseSkill(db, 'agent:dots', item.id, 'Again.', digest), refused);
    const extra = await endorseSkill(db, 'agent:muse', item.id, 'Second reviewer.', digest);
    assert.equal(extra.verdict, 'approve');
    assert.equal(extra.reviewer_id, 'agent:muse');
    await assert.rejects(() => endorseSkill(db, 'agent:muse', item.id, 'Again.', digest), refused);
    assert.equal(await reviewCount(db, item.id), 2);
    assert.equal((await db.prepare('SELECT reason FROM memory_reviews WHERE target_id=? AND reviewer_id=?').bind(item.id, 'agent:dots').first<{ reason: string }>())!.reason, 'Once.');
    assert.equal((await skillGrade(db, item.id)).letter, 'C');
  } finally { await close(); }
});

test('one, two, and three distinct approvals grade F, C, and A', async () => {
  const { db, close } = await start();
  try {
    await allow(db, 'agent:dots');
    await allow(db, 'agent:muse');
    await allow(db, 'agent:codex');
    await allow(db, 'agent:egg');
    const item = await proposeItem(db, 'agent:grok', skill());
    const digest = await itemContentDigest(item);
    const pending = await skillGrade(db, item.id);
    assert.equal(pending.letter, null);
    await reviewItem(db, 'agent:dots', item.id, 'approve', 'First scene.', digest);
    const dots = await reviewId(db, item.id, 'agent:dots');
    const f = await skillGrade(db, item.id);
    assert.deepEqual(pick(f), { letter: 'F', distinct_pass_reviewers: 1, rejects: 0, reason: null });
    sameIds(f.basis, [dots]);
    const muse = await endorseSkill(db, 'agent:muse', item.id, 'Second scene.', digest);
    const c = await skillGrade(db, item.id);
    assert.deepEqual(pick(c), { letter: 'C', distinct_pass_reviewers: 2, rejects: 0, reason: null });
    sameIds(c.basis, [dots, muse.id]);
    const codex = await endorseSkill(db, 'agent:codex', item.id, 'Third scene.', digest);
    const a = await skillGrade(db, item.id);
    assert.deepEqual(pick(a), { letter: 'A', distinct_pass_reviewers: 3, rejects: 0, reason: null });
    sameIds(a.basis, [dots, muse.id, codex.id]);
    const egg = await endorseSkill(db, 'agent:egg', item.id, 'Fourth scene stays A.', digest);
    const still = await skillGrade(db, item.id);
    assert.deepEqual(pick(still), { letter: 'A', distinct_pass_reviewers: 4, rejects: 0, reason: null });
    sameIds(still.basis, [dots, muse.id, codex.id, egg.id]);
    assert.equal((await db.prepare('SELECT review_state, valid_until FROM memory_items WHERE id=?').bind(item.id).first<{ review_state: string; valid_until: string | null }>())!.review_state, 'approved');
    assert.equal((await db.prepare('SELECT valid_until FROM memory_items WHERE id=?').bind(item.id).first<{ valid_until: string | null }>())!.valid_until, null);
    const before = await reviewCount(db, item.id);
    const reread = await skillGrade(db, item.id);
    assert.deepEqual(reread, still);
    assert.equal(await reviewCount(db, item.id), before);
    await assert.rejects(
      db.prepare('UPDATE memory_reviews SET reason=? WHERE id=?').bind('changed', muse.id).all(),
      (err: unknown) => err instanceof Error && /immutable review|ABORT/i.test(err.message),
    );
    assert.equal((await db.prepare('SELECT reason FROM memory_reviews WHERE id=?').bind(muse.id).first<{ reason: string }>())!.reason, 'Second scene.');
  } finally { await close(); }
});

function pick(grade: SkillGrade): { letter: SkillGrade['letter']; distinct_pass_reviewers: number; rejects: number; reason: string | null } {
  return { letter: grade.letter, distinct_pass_reviewers: grade.distinct_pass_reviewers, rejects: grade.rejects, reason: grade.reason };
}

test('a pending skill grades null', async () => {
  const { db, close } = await start();
  try {
    await allow(db, 'agent:dots');
    await allow(db, 'agent:muse');
    await allow(db, 'agent:codex');
    const item = await proposeItem(db, 'agent:grok', skill());
    const digest = await itemContentDigest(item);
    const empty = await skillGrade(db, item.id);
    assert.equal(empty.letter, null);
    assert.equal(empty.reason, 'A pending skill has no grade.');
    assert.equal(empty.distinct_pass_reviewers, 0);
    assert.equal(empty.rejects, 0);
    assert.deepEqual(empty.basis, []);
    await assert.rejects(() => endorseSkill(db, 'agent:dots', item.id, 'Too early.', digest), refused);
    for (const reviewerId of ['agent:dots', 'agent:muse', 'agent:codex']) {
      await db.prepare(`INSERT INTO memory_reviews(id, target_kind, target_id, verdict, reviewer_id, reason, content_digest, created_at)
        VALUES (?, 'item', ?, 'approve', ?, 'forged', ?, '2026-10-22T00:00:00.000Z')`).bind(`forge-${reviewerId}`, item.id, reviewerId, digest).all();
    }
    const forged = await skillGrade(db, item.id);
    assert.equal(forged.letter, null);
    assert.equal(forged.reason, 'A pending skill has no grade.');
    assert.equal(forged.distinct_pass_reviewers, 3);
    assert.equal((await db.prepare('SELECT review_state FROM memory_items WHERE id=?').bind(item.id).first<{ review_state: string }>())!.review_state, 'pending');
    const missing = await skillGrade(db, 'missing-skill');
    assert.equal(missing.letter, null);
    assert.equal(missing.reason, 'No such memory item.');
    assert.deepEqual(missing.basis, []);
  } finally { await close(); }
});

test('an endorsement with the wrong content digest is refused', async () => {
  const { db, close } = await start();
  try {
    await allow(db, 'agent:dots');
    await allow(db, 'agent:muse');
    const item = await proposeItem(db, 'agent:grok', skill());
    const digest = await itemContentDigest(item);
    await reviewItem(db, 'agent:dots', item.id, 'approve', 'Recorded.', digest);
    const wrong = await itemContentDigest({ ...item, body: 'A different body.' });
    assert.notEqual(wrong, digest);
    await assert.rejects(
      () => endorseSkill(db, 'agent:muse', item.id, 'Stale read.', wrong),
      (err: unknown) => err instanceof Fault && err.code === 'INVALID_INPUT' && /digest/i.test(err.message),
    );
    assert.equal(await reviewCount(db, item.id), 1);
    assert.equal((await skillGrade(db, item.id)).letter, 'F');
  } finally { await close(); }
});

test('a non-skill grades null', async () => {
  const { db, close } = await start();
  try {
    await allow(db, 'agent:dots');
    await allow(db, 'agent:muse');
    const fact = await proposeItem(db, 'agent:grok', skill({ kind: 'fact', tier: 1, title: 'A fact', body: 'Not a procedure.' }));
    const decision = await proposeItem(db, 'agent:grok', skill({ kind: 'decision', tier: 2, title: 'A decision', body: 'Not a procedure either.' }));
    const factDigest = await itemContentDigest(fact);
    const decisionDigest = await itemContentDigest(decision);
    await reviewItem(db, 'agent:dots', fact.id, 'approve', 'True.', factDigest);
    await reviewItem(db, 'agent:dots', decision.id, 'approve', 'Decided.', decisionDigest);
    for (const id of [fact.id, decision.id]) {
      const grade = await skillGrade(db, id);
      assert.equal(grade.letter, null);
      assert.equal(grade.reason, 'Only a skill is graded.');
      assert.equal(grade.distinct_pass_reviewers, 0);
      assert.equal(grade.rejects, 0);
      assert.deepEqual(grade.basis, []);
    }
    await assert.rejects(() => endorseSkill(db, 'agent:muse', fact.id, 'Not a skill.', factDigest), refused);
    assert.equal(await reviewCount(db, fact.id), 1);
  } finally { await close(); }
});

test('a rejected skill grades null', async () => {
  const { db, close } = await start();
  try {
    await allow(db, 'agent:dots');
    await allow(db, 'agent:muse');
    const item = await proposeItem(db, 'agent:grok', skill());
    const digest = await itemContentDigest(item);
    await reviewItem(db, 'agent:dots', item.id, 'reject', 'Not a procedure yet.', digest);
    const grade = await skillGrade(db, item.id);
    assert.equal(grade.letter, null);
    assert.equal(grade.reason, 'A rejected skill has no grade.');
    assert.equal(grade.rejects, 1);
    assert.equal(grade.distinct_pass_reviewers, 0);
    assert.equal(grade.basis.length, 1);
    await assert.rejects(() => endorseSkill(db, 'agent:muse', item.id, 'Too late.', digest), refused);
    assert.equal(await reviewCount(db, item.id), 1);
  } finally { await close(); }
});

test('a superseded skill grades null', async () => {
  const { db, close } = await start();
  try {
    await allow(db, 'agent:dots');
    const older = await proposeItem(db, 'agent:grok', skill({ title: 'Old skill', body: 'First procedure.', valid_from: T0 }));
    const newer = await proposeItem(db, 'agent:grok', skill({ title: 'New skill', body: 'Replacement procedure.', valid_from: T1 }));
    await reviewItem(db, 'agent:dots', older.id, 'approve', 'Recorded.', await itemContentDigest(older));
    await reviewItem(db, 'agent:dots', newer.id, 'approve', 'Recorded.', await itemContentDigest(newer));
    const edge = await proposeSupersede(db, 'agent:grok', older.id, newer.id);
    assert.equal((await skillGrade(db, older.id)).letter, 'F');
    await reviewEdge(db, 'agent:dots', edge.id, 'approve', 'The new procedure replaces it.', await edgeContentDigest(edge));
    const closed = await skillGrade(db, older.id);
    assert.equal(closed.letter, null);
    assert.equal(closed.reason, 'A superseded skill has no grade.');
    assert.equal(closed.distinct_pass_reviewers, 1);
    assert.equal(closed.rejects, 0);
    const replacement = await skillGrade(db, newer.id);
    assert.equal(replacement.letter, 'F');
    assert.equal(replacement.reason, null);
  } finally { await close(); }
});

test('a repeated approval from one reviewer does not raise the letter', async () => {
  const { db, close } = await start();
  try {
    await allow(db, 'agent:dots');
    const item = await proposeItem(db, 'agent:grok', skill());
    const digest = await itemContentDigest(item);
    await reviewItem(db, 'agent:dots', item.id, 'approve', 'Once.', digest);
    await db.prepare(`INSERT INTO memory_reviews(id, target_kind, target_id, verdict, reviewer_id, reason, content_digest, created_at)
      VALUES ('second-pass', 'item', ?, 'approve', 'agent:dots', 'same reviewer', ?, '2099-01-01T00:00:00.000Z')`).bind(item.id, digest).all();
    const grade = await skillGrade(db, item.id);
    assert.equal(grade.letter, 'F');
    assert.equal(grade.distinct_pass_reviewers, 1);
    assert.equal(grade.rejects, 0);
    assert.deepEqual(grade.basis, ['second-pass']);
  } finally { await close(); }
});

test('rows that are not an independent listed review of this content do not count', async () => {
  const { db, close } = await start();
  try {
    await allow(db, 'agent:grok');
    await allow(db, 'agent:dots');
    await allow(db, 'agent:muse');
    const item = await proposeItem(db, 'agent:grok', skill());
    const digest = await itemContentDigest(item);
    await reviewItem(db, 'agent:dots', item.id, 'approve', 'Counts.', digest);
    const wrong = 'ab'.repeat(32);
    await db.prepare(`INSERT INTO memory_reviews(id, target_kind, target_id, verdict, reviewer_id, reason, content_digest, created_at)
      VALUES ('self', 'item', ?, 'approve', 'agent:grok', 'self', ?, '2026-10-22T00:00:00.000Z')`).bind(item.id, digest).all();
    await db.prepare(`INSERT INTO memory_reviews(id, target_kind, target_id, verdict, reviewer_id, reason, content_digest, created_at)
      VALUES ('outsider', 'item', ?, 'approve', 'agent:outsider', 'unlisted', ?, '2026-10-22T00:00:01.000Z')`).bind(item.id, digest).all();
    await db.prepare(`INSERT INTO memory_reviews(id, target_kind, target_id, verdict, reviewer_id, reason, content_digest, created_at)
      VALUES ('stale', 'item', ?, 'approve', 'agent:muse', 'wrong hash', ?, '2026-10-22T00:00:02.000Z')`).bind(item.id, wrong).all();
    const grade = await skillGrade(db, item.id);
    assert.equal(grade.letter, 'F');
    assert.equal(grade.distinct_pass_reviewers, 1);
    assert.equal(grade.basis.length, 1);
    assert.equal(grade.basis[0], await reviewId(db, item.id, 'agent:dots'));
  } finally { await close(); }
});

test('an approved flag with no matching review is not a letter', async () => {
  const { db, close } = await start();
  try {
    await allow(db, 'agent:dots');
    const item = await proposeItem(db, 'agent:grok', skill());
    const wrong = 'cd'.repeat(32);
    await db.prepare(`INSERT INTO memory_reviews(id, target_kind, target_id, verdict, reviewer_id, reason, content_digest, created_at)
      VALUES ('mismatch', 'item', ?, 'approve', 'agent:dots', 'wrong hash', ?, '2026-10-22T00:00:00.000Z')`).bind(item.id, wrong).all();
    await db.prepare("UPDATE memory_items SET review_state='approved' WHERE id=?").bind(item.id).all();
    const grade = await skillGrade(db, item.id);
    assert.equal(grade.letter, null);
    assert.equal(grade.reason, 'Needs one independent approval on this content hash.');
    assert.equal(grade.distinct_pass_reviewers, 0);
    assert.deepEqual(grade.basis, []);
  } finally { await close(); }
});

test('an open rejection blocks the letter', async () => {
  const { db, close } = await start();
  try {
    await allow(db, 'agent:dots');
    await allow(db, 'agent:muse');
    await allow(db, 'agent:codex');
    const item = await proposeItem(db, 'agent:grok', skill());
    const digest = await itemContentDigest(item);
    await reviewItem(db, 'agent:dots', item.id, 'approve', 'First.', digest);
    await endorseSkill(db, 'agent:codex', item.id, 'Second.', digest);
    await db.prepare(`INSERT INTO memory_reviews(id, target_kind, target_id, verdict, reviewer_id, reason, content_digest, created_at)
      VALUES ('block', 'item', ?, 'reject', 'agent:muse', 'Open fail.', ?, '2026-10-23T00:00:00.000Z')`).bind(item.id, digest).all();
    const blocked = await skillGrade(db, item.id);
    assert.equal(blocked.letter, null);
    assert.equal(blocked.reason, 'An open rejection blocks the grade: agent:muse');
    assert.equal(blocked.distinct_pass_reviewers, 2);
    assert.equal(blocked.rejects, 1);
    assert.equal(blocked.basis.length, 3);
  } finally { await close(); }
});
