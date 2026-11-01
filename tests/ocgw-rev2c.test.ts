import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { migrate } from '../scripts/local-harness.ts';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import { legacyItemCanonical, sha256Hex, type ItemCanonFields } from '../src/server/canonical.ts';
import { legacyValidFromCandidates, skillGrade } from '../src/server/skill-grade.ts';
import { proposeItem, proposePromotion } from '../src/server/memory-items.ts';
import { itemContentDigest, reviewItem } from '../src/server/memory-review.ts';
import { proposeExperience } from '../src/server/experience.ts';
import { contextPack } from '../src/server/context-pack.ts';
import { roomBrief, SKILL_LIMIT } from '../src/server/room-brief.ts';
import type { Database } from '../src/server/db.ts';

// OCG-W rev2c: Codex ec45569a findings at pin 80cc719.
async function start(through: number): Promise<{ db: Database; close: () => Promise<void> }> {
  const d1 = await cloneD1(through);
  const mf = new Miniflare({ modules: true, script: 'export default { async fetch() { return new Response(null, { status: 204 }); } }',
    compatibilityDate: '2026-07-28', d1Databases: { DB: D1_TEMPLATE_NAME }, d1Persist: d1.dir, cf: false } as ConstructorParameters<typeof Miniflare>[0]);
  await mf.ready;
  const db = await mf.getD1Database('DB') as Database;
  await migrate(db, through);
  await db.batch([
    db.prepare("INSERT INTO rooms(id) VALUES ('room_main')"),
    db.prepare("INSERT INTO principals(id) VALUES ('agent:grok')"),
    db.prepare("INSERT INTO principals(id) VALUES ('agent:dots')"),
    db.prepare("INSERT INTO memberships(principal_id,room_id,active,can_post) VALUES ('agent:grok','room_main',1,1)"),
    db.prepare("INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES ('msg-1','room_main','agent:grok','run the suite twice before merge','text','2026-10-01T00:00:00.000Z')"),
    db.prepare("INSERT INTO memory_reviewers(principal_id, added_at) VALUES ('agent:dots','2026-10-22T00:00:00.000Z')"),
  ]);
  return { db, close: () => mf.dispose().then(d1.cleanup) };
}

/** Apply the 0018 that was deployed to the test D1 before 61ffdcb (git 5b1abd2), then record it as applied. */
async function applyOriginal0018(db: Database) {
  const sql = await readFile('tests/fixtures/0018_original_5b1abd2.sql', 'utf8');
  const statements = sql.trim().split(/;\s*\n/).filter(s => s.trim()).map(s => db.prepare(s));
  await db.batch([...statements, db.prepare("INSERT INTO local_migrations(name) VALUES ('0018_ocgw_review_hardening.sql')")]);
}

const T0 = '2026-10-01T00:00:00.000Z';
const canonItem = async (db: Database, id: string) => (await db.prepare('SELECT id, room_id, kind, tier, title, body, valid_from, source_message_id, source_version FROM memory_items WHERE id=?').bind(id).first<ItemCanonFields>())!;

test('candidates cover instant-equivalent pre-rev2 spellings and only those', () => {
  const c = legacyValidFromCandidates(T0);
  for (const raw of ['2026-10-01T00:00:00Z', '2026-10-01T00:00:00.000Z', '2026-10-01T09:00:00+09:00', '2026-10-01T09:00:00.0+09:00', '2026-09-30T20:00:00-04:00', '2026-10-01T05:45:00+05:45', '2026-10-01T00:00:00+00:00', '2026-10-01T00:00:00.000000Z'])
    assert.ok(c.includes(raw), raw);
  for (const raw of c) assert.equal(Date.parse(raw), Date.parse(T0), raw);
});

test('original 0018 -> 0020: recoverable v1 reviews still count; unrecoverable ones are quarantined (approve never counts, reject withholds)', async () => {
  const { db, close } = await start(16);
  try {
    const item = (id: string, raw: string) => db.prepare(`INSERT INTO memory_items(id,room_id,kind,tier,title,body,source_message_id,proposed_by,valid_from,review_state,created_at)
      VALUES (?,'room_main','skill',0,'Skill','Run the suite twice.','msg-1','agent:grok',?,'approved','2026-10-22T18:40:35.167Z')`).bind(id, raw);
    const review = async (id: string, target: string, verdict: string, raw: string, at: string) => db.prepare(`INSERT INTO memory_reviews(id,target_kind,target_id,verdict,reviewer_id,reason,content_digest,created_at)
      VALUES (?,'item',?,?,'agent:dots','legacy',?,?)`).bind(id, target, verdict, await sha256Hex(legacyItemCanonical('Skill', 'Run the suite twice.', raw)), at);
    const kst = '2026-10-01T09:00:00+09:00';
    const lost = '2026-10-01T00:00:00.1234567Z';
    await db.batch([item('sk-kst', kst), item('sk-lost', lost), item('sk-lost-rej', lost),
      await review('rv-kst', 'sk-kst', 'approve', kst, '2026-10-02T00:00:00.000Z'),
      await review('rv-lost', 'sk-lost', 'approve', lost, '2026-10-02T00:00:00.000Z'),
      await review('rv-lost-rej', 'sk-lost-rej', 'reject', lost, '2026-10-02T00:00:00.000Z')]);
    await applyOriginal0018(db);
    await migrate(db, 20);
    const rows = (await db.prepare("SELECT id, valid_from, legacy_valid_from FROM memory_items ORDER BY id").all<{ id: string; valid_from: string; legacy_valid_from: string | null }>()).results;
    assert.ok(rows.every(r => r.legacy_valid_from === null), 'original 0018 erased the preimage before 0019 could keep it');
    assert.equal(rows.find(r => r.id === 'sk-kst')!.valid_from, T0);
    const kstGrade = await skillGrade(db, 'sk-kst');
    assert.equal(kstGrade.letter, 'F', 'KST spelling is re-matched by digest');
    assert.deepEqual(kstGrade.basis, ['rv-kst']);
    assert.deepEqual(kstGrade.unresolved_provenance, []);
    const lostGrade = await skillGrade(db, 'sk-lost');
    assert.equal(lostGrade.letter, null);
    assert.deepEqual(lostGrade.unresolved_provenance, ['rv-lost']);
    assert.equal(lostGrade.reason, 'Needs one independent approval on this content hash.', 'an unresolved approve never adds a pass');
    const rej = await skillGrade(db, 'sk-lost-rej');
    assert.equal(rej.letter, null, 'an unmatchable legacy rejection never silently disappears');
    assert.deepEqual(rej.unresolved_provenance, ['rv-lost-rej']);
    assert.match(rej.reason ?? '', /rejection\(s\) have unresolved provenance/);
  } finally { await close(); }
});

test('0020 labels every pre-0020 version as inferred; new rows are pinned; basis is frozen and copied on promotion; pack and brief expose it', async () => {
  const { db, close } = await start(19);
  try {
    // Rows as rev2b code (through 0019) wrote them: raw SQL, because current code selects the 0020 column.
    await db.batch([
      db.prepare(`INSERT INTO memory_items(id,room_id,kind,tier,title,body,source_message_id,source_version,proposed_by,review_state,valid_from,created_at)
        VALUES ('mi-old','room_main','decision',0,'Old decision','Suite twice before merge.','msg-1',1,'agent:grok','approved',?,'2026-10-22T00:00:00.000Z')`).bind(T0),
      db.prepare(`INSERT INTO experience_entries(id,room_id,component,change,prediction,source_message_id,source_version,proposed_by,state,outcome,outcome_message_id,outcome_message_version,observed_by,observed_at,verdict_by,verdict_reason,verdict_digest,verdict_at,created_at)
        VALUES ('exp-old','room_main','memory','c','p','msg-1',1,'agent:grok','kept','o','msg-1',1,'agent:grok','2026-10-02T00:00:00.000Z','agent:dots','r',?,'2026-10-03T00:00:00.000Z','2026-10-01T12:00:00.000Z')`).bind('a'.repeat(64)),
    ]);
    const old = { id: 'mi-old' };
    await migrate(db, 25);
    const basis = async (t: string, id: string) => (await db.prepare(`SELECT version_basis b FROM ${t} WHERE id=?`).bind(id).first<{ b: string }>())!.b;
    assert.equal(await basis('memory_items', old.id), 'inferred');
    assert.equal(await basis('experience_entries', 'exp-old'), 'inferred', 'kept rows are labeled despite experience_frozen_fields');
    const fresh = await proposeItem(db, 'agent:grok', { room_id: 'room_main', kind: 'decision', tier: 0, title: 'New decision', body: 'Suite twice before merge, pinned.', source_message_id: 'msg-1', valid_from: '2026-10-02T00:00:00.000Z' });
    assert.equal(fresh.version_basis, 'pinned');
    assert.equal(await basis('experience_entries', (await proposeExperience(db, 'agent:grok', { room_id: 'room_main', component: 'memory', change: 'c2', prediction: 'p2', source_message_id: 'msg-1' })).id), 'pinned');
    await assert.rejects(db.prepare('UPDATE memory_items SET version_basis=? WHERE id=?').bind('pinned', old.id).all(), /immutable/);
    await assert.rejects(db.prepare("UPDATE experience_entries SET version_basis='pinned' WHERE id='exp-old'").all(), /immutable/);
    const promo = await proposePromotion(db, 'agent:grok', { from_id: old.id, title: 'Old decision', body: 'Suite twice before merge (tier 1).' });
    assert.equal(promo.item.version_basis, 'inferred', 'a promotion never upgrades an inferred pin');
    await reviewItem(db, 'agent:dots', fresh.id, 'approve', 'ok', await itemContentDigest(await canonItem(db, fresh.id)));
    const pack = await contextPack(db, 'room_main', 'suite merge', 4000, '2026-10-05T00:00:00.000Z');
    const byId = new Map([...pack.sections.decisions, ...pack.sections.messages].map(e => [e.id, e.source_version_basis]));
    assert.equal(byId.get(old.id), 'inferred');
    assert.equal(byId.get(fresh.id), 'pinned');
    if (byId.has('msg-1')) assert.equal(byId.get('msg-1'), 'current');
    const brief = await roomBrief(db, 'room_main', { at: '2026-10-05T00:00:00.000Z' });
    assert.deepEqual(Object.fromEntries(brief.decisions.map(d => [d.id, d.source_version_basis])), { [old.id]: 'inferred', [fresh.id]: 'pinned' });
    assert.ok(brief.notes.some(n => n.includes('Navigation only, mixed time')));
  } finally { await close(); }
});

test('brief grades at most SKILL_LIMIT skills (highest tier, newest first) and says so', async () => {
  const { db, close } = await start(25);
  try {
    const n = SKILL_LIMIT + 3;
    await db.batch(Array.from({ length: n }, (_, i) => db.prepare(`INSERT INTO memory_items(id,room_id,kind,tier,title,body,source_message_id,source_version,proposed_by,review_state,valid_from,created_at)
      VALUES (?,'room_main','skill',?,?,'b','msg-1',1,'agent:grok','approved',?,'2026-10-22T00:00:00.000Z')`).bind(`sk-${String(i).padStart(2, '0')}`, i === 0 ? 2 : 0, `S${i}`, new Date(Date.parse(T0) + i * 60000).toISOString())));
    const brief = await roomBrief(db, 'room_main', { at: '2026-10-05T00:00:00.000Z', maxChars: 8000 });
    assert.equal(brief.skills.length, SKILL_LIMIT);
    assert.equal(brief.skills[0]!.id, 'sk-00', 'highest tier first');
    assert.equal(brief.skills[1]!.id, `sk-${String(n - 1).padStart(2, '0')}`, 'then newest');
    assert.ok(!brief.skills.some(s => s.id === 'sk-01' || s.id === 'sk-02'), 'oldest tier-0 skills are not graded');
    assert.ok(brief.notes.some(note => note.includes('More valid skills exist')));
  } finally { await close(); }
});

test('an injected failure inside 0020 rolls the whole migration back', async () => {
  const { db, close } = await start(19);
  try {
    // Codex d5c3553b: populated data, then restoration and a clean retry.
    await db.prepare("INSERT INTO memory_items(id,room_id,kind,tier,title,body,source_message_id,source_version,proposed_by,review_state,valid_from,created_at) VALUES ('keep-1','room_main','decision',1,'Keep me','Survives the rollback.','msg-1',1,'agent:grok','pending','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z')").all();
    const seeded = { id: 'keep-1' };
    const before = await db.prepare('SELECT * FROM memory_items WHERE id=?').bind(seeded.id).first();
    await db.prepare("CREATE TRIGGER memory_items_basis_frozen BEFORE DELETE ON rooms BEGIN SELECT 1; END").all();
    await assert.rejects(migrate(db, 20), /already exists/);
    const cols = (await db.prepare("SELECT name FROM pragma_table_info('memory_items')").all<{ name: string }>()).results.map(c => c.name);
    assert.ok(!cols.includes('version_basis'), 'ALTER rolled back');
    assert.equal((await db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name='experience_frozen_fields'").first<{ n: number }>())!.n, 1, 'DROP rolled back');
    assert.equal(await db.prepare("SELECT 1 FROM local_migrations WHERE name LIKE '0020%'").first(), null);
    assert.deepEqual(await db.prepare('SELECT * FROM memory_items WHERE id=?').bind(seeded.id).first(), before, 'populated row restored unchanged');
    await db.prepare('DROP TRIGGER memory_items_basis_frozen').all();
    await migrate(db, 20);
    assert.ok(await db.prepare("SELECT 1 FROM local_migrations WHERE name LIKE '0020%'").first(), 'retry applied 0020');
    const after = await db.prepare('SELECT title, body, version_basis FROM memory_items WHERE id=?').bind(seeded.id).first<{ title: string; body: string; version_basis: string }>();
    assert.equal(after?.title, 'Keep me');
    assert.equal(after?.version_basis, 'inferred', 'pre-0020 row is marked inferred after the retry');
  } finally { await close(); }
});
