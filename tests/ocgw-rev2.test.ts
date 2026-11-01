import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { migrate } from '../scripts/local-harness.ts';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import { Fault } from '../src/server/contracts.ts';
import { instant, legacyItemCanonical, sha256Hex } from '../src/server/canonical.ts';
import { skillGrade } from '../src/server/skill-grade.ts';
import type { EdgeCanonFields, ItemCanonFields } from '../src/server/canonical.ts';
import { proposeItem, proposePromotion, type ProposeItemInput } from '../src/server/memory-items.ts';
import { edgeContentDigest, itemContentDigest, reviewEdge, reviewItem } from '../src/server/memory-review.ts';
import { observeExperience, proposeExperience } from '../src/server/experience.ts';
import { contextPack } from '../src/server/context-pack.ts';
import { Workroom } from '../src/server/domain.ts';
import type { Database } from '../src/server/db.ts';

// OCG-W rev2 (migration 0018): adversarial tests for the Codex W1-W7 review findings.
async function start(through = 20): Promise<{ db: Database; close: () => Promise<void> }> {
  const d1 = await cloneD1(through);
  const mf = new Miniflare({
    modules: true,
    script: 'export default { async fetch() { return new Response(null, { status: 204 }); } }',
    compatibilityDate: '2026-07-28',
    d1Databases: { DB: D1_TEMPLATE_NAME }, d1Persist: d1.dir,
    cf: false,
  } as ConstructorParameters<typeof Miniflare>[0]);
  await mf.ready;
  const db = await mf.getD1Database('DB') as Database;
  await migrate(db, through);
  await db.batch([
    db.prepare("INSERT INTO rooms(id) VALUES ('room_main')"),
    db.prepare("INSERT INTO rooms(id) VALUES ('room_other')"),
    db.prepare("INSERT INTO principals(id) VALUES ('agent:grok')"),
    db.prepare("INSERT INTO principals(id) VALUES ('agent:dots')"),
    db.prepare("INSERT INTO memberships(principal_id,room_id,active,can_post) VALUES ('agent:grok','room_main',1,1)"),
    db.prepare("INSERT INTO memberships(principal_id,room_id,active,can_post) VALUES ('agent:grok','room_other',1,1)"),
    db.prepare("INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES ('msg-1','room_main','agent:grok','retention stays dry-run','text','2026-10-01T00:00:00.000Z')"),
    db.prepare("INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES ('msg-o','room_other','agent:grok','other room retention','text','2026-10-01T00:00:00.000Z')"),
    ...(through >= 14 ? [db.prepare("INSERT INTO memory_reviewers(principal_id, added_at) VALUES ('agent:dots','2026-10-22T00:00:00.000Z')")] : []),
  ]);
  return { db, close: () => mf.dispose().then(d1.cleanup) };
}

const T0 = '2026-10-01T00:00:00.000Z';
const refused = (err: unknown) => err instanceof Fault && err.code === 'INVALID_INPUT';
const input = (over: Partial<ProposeItemInput> = {}): ProposeItemInput => ({ room_id: 'room_main', kind: 'fact', tier: 0, title: 'Episode', body: 'Retention stays dry-run.', source_message_id: 'msg-1', valid_from: T0, ...over });
const canonItem = async (db: Database, id: string) => (await db.prepare('SELECT id, room_id, kind, tier, title, body, valid_from, source_message_id, source_version FROM memory_items WHERE id=?').bind(id).first<ItemCanonFields>())!;
const canonEdge = async (db: Database, id: string) => (await db.prepare('SELECT id, src_id, dst_id, type FROM memory_edges WHERE id=?').bind(id).first<EdgeCanonFields>())!;

test('instant normalizes offsets to UTC ms and rejects bad dates and sub-millisecond precision', () => {
  assert.equal(instant('2026-10-01T09:00:00+09:00', 'valid_from'), '2026-10-01T00:00:00.000Z');
  assert.equal(instant('2026-10-01T00:00:00Z', 'valid_from'), '2026-10-01T00:00:00.000Z');
  assert.equal(instant('2026-10-01T00:00:00.123000Z', 'valid_from'), '2026-10-01T00:00:00.123Z');
  for (const bad of ['2026-02-30T00:00:00Z', '2026-10-01T00:00:00.0001Z', '2026-10-01T00:00:00+24:00', '2026-10-01', 'yesterday'])
    assert.throws(() => instant(bad, 'valid_from'), refused, bad);
});

test('timezone-equivalent valid_from inputs store the same digest', async () => {
  const { db, close } = await start();
  try {
    const a = await proposeItem(db, 'agent:grok', input({ id: 'mi-a', valid_from: '2026-10-01T09:00:00+09:00' }));
    const b = await proposeItem(db, 'agent:grok', input({ id: 'mi-a2', valid_from: '2026-10-01T00:00:00Z' }));
    assert.equal(a.valid_from, T0);
    assert.equal(b.valid_from, T0);
    assert.equal(await itemContentDigest({ ...(await canonItem(db, a.id)), id: 'x' }), await itemContentDigest({ ...(await canonItem(db, b.id)), id: 'x' }));
  } finally { await close(); }
});

test('inverted or empty validity windows are refused by code and by the 0018 trigger', async () => {
  const { db, close } = await start();
  try {
    await assert.rejects(proposeItem(db, 'agent:grok', input({ valid_until: T0 })), refused);
    await assert.rejects(proposeItem(db, 'agent:grok', input({ valid_until: '2026-09-01T00:00:00.000Z' })), refused);
    await assert.rejects(db.prepare(`INSERT INTO memory_items(id,room_id,kind,tier,title,body,source_message_id,source_version,proposed_by,valid_from,valid_until,created_at)
      VALUES ('raw','room_main','fact',0,'t','b','msg-1',1,'agent:grok','2026-10-02T00:00:00.000Z','2026-10-01T00:00:00.000Z','2026-10-22T00:00:00.000Z')`).all(), /validity window/);
    await assert.rejects(db.prepare(`INSERT INTO memory_items(id,room_id,kind,tier,title,body,source_message_id,source_version,proposed_by,valid_from,created_at)
      VALUES ('raw2','room_main','fact',0,'t','b','msg-1',1,'agent:grok','2026-10-01T09:00:00+09:00','2026-10-22T00:00:00.000Z')`).all(), /validity window/);
    await assert.rejects(db.prepare(`INSERT INTO memory_items(id,room_id,kind,tier,title,body,source_message_id,source_version,proposed_by,valid_from,created_at)
      VALUES ('raw3','room_main','fact',0,'t','b','msg-1',7,'agent:grok','2026-10-01T00:00:00.000Z','2026-10-22T00:00:00.000Z')`).all(), /pinned source version/);
  } finally { await close(); }
});

test('Workroom refuses IDs from another room on supersede, promote, review and grade', async () => {
  const { db, close } = await start();
  try {
    const mine = await proposeItem(db, 'agent:grok', input({ id: 'mi-main' }));
    const theirs = await proposeItem(db, 'agent:grok', input({ id: 'mi-other', room_id: 'room_other', source_message_id: 'msg-o', valid_from: '2026-10-02T00:00:00.000Z' }));
    const w = new Workroom(db, 'agent:grok');
    await assert.rejects(w.memorySupersede({ room: 'room_main', old_id: mine.id, new_id: theirs.id }), refused);
    await assert.rejects(w.memoryPromote({ room: 'room_main', from_id: theirs.id, title: 'x', body: 'y' }), refused);
    await assert.rejects(w.memoryReview({ room: 'room_main', target: 'item', id: theirs.id, verdict: 'approve', reason: 'r', content_digest: 'a'.repeat(64) }), refused);
    await assert.rejects(w.skillGrade({ room: 'room_main', id: theirs.id }), refused);
  } finally { await close(); }
});

test('a rejected promoted item does not block a promotion retry', async () => {
  const { db, close } = await start();
  try {
    const l0 = await proposeItem(db, 'agent:grok', input());
    await reviewItem(db, 'agent:dots', l0.id, 'approve', 'ok', await itemContentDigest(await canonItem(db, l0.id)));
    const first = await proposePromotion(db, 'agent:grok', { from_id: l0.id, title: 'Fact', body: 'First wording.' });
    await reviewEdge(db, 'agent:dots', first.edge.id, 'approve', 'ok', await edgeContentDigest(await canonEdge(db, first.edge.id)));
    await reviewItem(db, 'agent:dots', first.item.id, 'reject', 'bad wording', await itemContentDigest(await canonItem(db, first.item.id)));
    const retry = await proposePromotion(db, 'agent:grok', { from_id: l0.id, title: 'Fact', body: 'Better wording.' });
    assert.equal(retry.item.tier, 1);
    assert.equal(retry.item.source_version, 1);
  } finally { await close(); }
});

test('the pack keeps the pinned source excerpt after the message is edited', async () => {
  const { db, close } = await start();
  try {
    const item = await proposeItem(db, 'agent:grok', input({ tier: 1, body: 'Retention dry-run fact.' }));
    assert.equal(item.source_version, 1);
    await reviewItem(db, 'agent:dots', item.id, 'approve', 'ok', await itemContentDigest(await canonItem(db, item.id)));
    await db.prepare("INSERT INTO message_revisions(id,message_id,version,editor_id,text,format,created_at) VALUES ('rev-1','msg-1',2,'agent:grok','retention now deletes rows','text','2026-10-21T00:00:00.000Z')").all();
    const pack = await contextPack(db, 'room_main', 'retention', 4000, '2026-10-23T00:00:00.000Z');
    const fact = pack.sections.facts.find(e => e.id === item.id)!;
    assert.equal(fact.source_version, 1);
    assert.equal(fact.source_current_version, 2);
    assert.match(fact.source_excerpt ?? '', /dry-run/);
    assert.doesNotMatch(fact.source_excerpt ?? '', /deletes/);
  } finally { await close(); }
});

test('experience pins source and outcome message versions', async () => {
  const { db, close } = await start();
  try {
    await db.prepare("INSERT INTO message_revisions(id,message_id,version,editor_id,text,format,created_at) VALUES ('rev-1','msg-1',2,'agent:grok','edited','text','2026-10-21T00:00:00.000Z')").all();
    const e = await proposeExperience(db, 'agent:grok', { room_id: 'room_main', component: 'memory', change: 'c', prediction: 'p', source_message_id: 'msg-1' });
    assert.equal(e.source_version, 2);
    const o = await observeExperience(db, 'agent:grok', e.id, 'held', 'msg-1');
    assert.equal(o.outcome_message_version, 2);
    await assert.rejects(db.prepare('UPDATE experience_entries SET source_version=1 WHERE id=?').bind(e.id).all(), /ABORT|frozen|immutable|version/i);
  } finally { await close(); }
});

test('populated 16 -> 18 migration backfills source_version, normalizes instants and freezes them', async () => {
  const { db, close } = await start(16);
  try {
    await db.prepare(`INSERT INTO memory_items(id,room_id,kind,tier,title,body,source_message_id,proposed_by,valid_from,created_at)
      VALUES ('legacy','room_main','fact',0,'t','b','msg-1','agent:grok','2026-10-01T00:00:00Z','2026-10-22T18:40:35.167Z')`).all();
    await db.prepare("INSERT INTO message_revisions(id,message_id,version,editor_id,text,format,created_at) VALUES ('rev-late','msg-1',2,'agent:grok','edited later','text','2026-10-23T00:00:00.000Z')").all();
    await migrate(db, 20);
    const row = (await db.prepare("SELECT valid_from, source_version FROM memory_items WHERE id='legacy'").first<{ valid_from: string; source_version: number }>())!;
    assert.deepEqual(row, { valid_from: T0, source_version: 1 }, 'version current at item creation, not the later edit');
    await assert.rejects(db.prepare("UPDATE memory_items SET source_version=2 WHERE id='legacy'").all(), /ABORT|immutable|frozen|append-only/i);
  } finally { await close(); }
});

test('populated 16 -> 18 migration upgrades finalized (kept/reverted) and observed legacy experience rows (through 19), then keeps them frozen', async () => {
  // Codex 7807a4d8: 0015 experience_frozen_fields refuses any UPDATE of a kept/reverted row, so the 0018 backfill must not trip it.
  const { db, close } = await start(16);
  try {
    const cols = 'id,room_id,component,change,prediction,source_message_id,proposed_by,state,outcome,outcome_message_id,observed_by,observed_at,verdict_by,verdict_reason,verdict_digest,verdict_at,created_at';
    const row = (id: string, state: string, verdict: boolean) => db.prepare(`INSERT INTO experience_entries(${cols}) VALUES (?,'room_main','memory','c','p','msg-1','agent:grok',?,'o','msg-1','agent:grok','2026-10-02T00:00:00.000Z',?,?,?,?,'2026-10-01T12:00:00.000Z')`)
      .bind(id, state, verdict ? 'agent:dots' : null, verdict ? 'r' : null, verdict ? 'a'.repeat(64) : null, verdict ? '2026-10-03T00:00:00.000Z' : null);
    await db.batch([row('exp-kept', 'kept', true), row('exp-rev', 'reverted', true), row('exp-obs', 'observed', false), db.prepare(`INSERT INTO experience_entries(id,room_id,component,change,prediction,source_message_id,proposed_by,created_at) VALUES ('exp-prop','room_main','skills','c','p','msg-1','agent:grok','2026-10-01T12:00:00.000Z')`)]);
    await db.prepare("INSERT INTO message_revisions(id,message_id,version,editor_id,text,format,created_at) VALUES ('rev-late','msg-1',2,'agent:grok','edited later','text','2026-10-23T00:00:00.000Z')").all();
    await migrate(db, 20);
    const rows = (await db.prepare('SELECT id, state, source_version, outcome_message_version FROM experience_entries ORDER BY id').all<{ id: string; state: string; source_version: number; outcome_message_version: number }>()).results;
    assert.deepEqual(rows, [
      { id: 'exp-kept', state: 'kept', source_version: 1, outcome_message_version: 1 },
      { id: 'exp-obs', state: 'observed', source_version: 1, outcome_message_version: 1 },
      { id: 'exp-prop', state: 'proposed', source_version: 1, outcome_message_version: null },
      { id: 'exp-rev', state: 'reverted', source_version: 1, outcome_message_version: 1 },
    ]);
    await assert.rejects(db.prepare("UPDATE experience_entries SET change='x' WHERE id='exp-kept'").all(), /immutable/i, '0015 frozen-fields trigger is back');
    await assert.rejects(db.prepare("UPDATE experience_entries SET source_version=2 WHERE id='exp-obs'").all(), /immutable/i, '0018 version freeze holds');
    const trig = await db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name='experience_frozen_fields'").first<{ n: number }>();
    assert.equal(trig?.n, 1);
  } finally { await close(); }
});

test('populated 16 -> 19 upgrade keeps legacy v1 skill reviews counting when valid_from was noncanonical (positive and negative)', async () => {
  // Codex 62032de8 P2: normalizing valid_from must not orphan the stored v1 digest (title, body, valid_from as stored before rev2).
  const { db, close } = await start(16);
  try {
    const raw = '2026-10-01T00:00:00Z';
    const v1 = await sha256Hex(legacyItemCanonical('Skill', 'Run the suite twice.', raw));
    const item = (id: string) => db.prepare(`INSERT INTO memory_items(id,room_id,kind,tier,title,body,source_message_id,proposed_by,valid_from,created_at)
      VALUES (?,'room_main','skill',0,'Skill','Run the suite twice.','msg-1','agent:grok',?,'2026-10-22T18:40:35.167Z')`).bind(id, raw);
    const review = (id: string, target: string, verdict: string, at: string) => db.prepare(`INSERT INTO memory_reviews(id,target_kind,target_id,verdict,reviewer_id,reason,content_digest,created_at)
      VALUES (?,'item',?,?,'agent:dots','legacy',?,?)`).bind(id, target, verdict, v1, at);
    await db.batch([item('sk-pos'), item('sk-neg'), review('rv-pos', 'sk-pos', 'approve', '2026-10-02T00:00:00.000Z'), review('rv-neg-a', 'sk-neg', 'approve', '2026-10-02T00:00:00.000Z')]);
    await db.prepare("UPDATE memory_items SET review_state='approved' WHERE id IN ('sk-pos','sk-neg')").all();
    await review('rv-neg-r', 'sk-neg', 'reject', '2026-10-03T00:00:00.000Z').all();
    await migrate(db, 20);
    const rows = (await db.prepare("SELECT id, valid_from, legacy_valid_from FROM memory_items WHERE id LIKE 'sk-%' ORDER BY id").all()).results;
    assert.deepEqual(rows, [{ id: 'sk-neg', valid_from: T0, legacy_valid_from: raw }, { id: 'sk-pos', valid_from: T0, legacy_valid_from: raw }]);
    const pos = await skillGrade(db, 'sk-pos');
    assert.equal(pos.letter, 'F', 'legacy approval still counts after normalization');
    assert.deepEqual(pos.basis, ['rv-pos']);
    const neg = await skillGrade(db, 'sk-neg');
    assert.equal(neg.letter, null);
    assert.equal(neg.reason, 'An open rejection blocks the grade: agent:dots', 'legacy rejection still blocks');
    await assert.rejects(db.prepare("UPDATE memory_items SET legacy_valid_from=NULL WHERE id='sk-pos'").all(), /immutable/i);
    await assert.rejects(db.prepare(`INSERT INTO memory_items(id,room_id,kind,tier,title,body,source_message_id,source_version,proposed_by,valid_from,legacy_valid_from,created_at)
      VALUES ('forged','room_main','skill',0,'S','B','msg-1',1,'agent:grok',?, 'x','2026-10-23T00:00:00.000Z')`).bind(T0).all(), /legacy_valid_from|ABORT/i);
    const canonical = (await db.prepare("SELECT legacy_valid_from FROM memory_items WHERE id NOT LIKE 'sk-%'").all<{ legacy_valid_from: string | null }>()).results;
    assert.ok(canonical.every(r => r.legacy_valid_from === null), 'already canonical rows keep NULL');
  } finally { await close(); }
});
