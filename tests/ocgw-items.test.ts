import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { migrate } from '../scripts/local-harness.ts';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import { Fault } from '../src/server/contracts.ts';
import { proposeItem, proposeSupersede, validView, type ProposeItemInput } from '../src/server/memory-items.ts';
import type { Database } from '../src/server/db.ts';

// Each test owns a Miniflare D1, same start/migrate shape as tests/g5.test.ts, through migration 0013.
async function start(): Promise<{ db: Database; close: () => Promise<void> }> {
  const d1 = await cloneD1(13);
  const mf = new Miniflare({
    modules: true,
    script: 'export default { async fetch() { return new Response(null, { status: 204 }); } }',
    compatibilityDate: '2026-07-28',
    d1Databases: { DB: D1_TEMPLATE_NAME }, d1Persist: d1.dir,
    cf: false,
  } as ConstructorParameters<typeof Miniflare>[0]);
  await mf.ready;
  const db = await mf.getD1Database('DB') as Database;
  await migrate(db, 13);
  // W2 unit scope: raw table semantics before the 0014+ review triggers. Only the 0018/0020 columns the item code reads are added.
  await db.prepare('ALTER TABLE memory_items ADD COLUMN source_version INTEGER').all();
  await db.prepare("ALTER TABLE memory_items ADD COLUMN version_basis TEXT NOT NULL DEFAULT 'pinned'").all();
  await db.batch([
    db.prepare("INSERT INTO rooms(id) VALUES ('room_main')"),
    db.prepare("INSERT INTO rooms(id) VALUES ('room_other')"),
    db.prepare("INSERT INTO principals(id) VALUES ('agent:grok')"),
    db.prepare("INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES ('msg-1','room_main','agent:grok','source text','text','2026-10-01T00:00:00.000Z')"),
    db.prepare("INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES ('msg-2','room_other','agent:grok','other room','text','2026-10-01T00:00:00.000Z')"),
  ]);
  return { db, close: () => mf.dispose().then(d1.cleanup) };
}

const AT = '2026-10-23T00:00:00.000Z';

function input(over: Partial<ProposeItemInput> = {}): ProposeItemInput {
  return {
    room_id: 'room_main', kind: 'fact', tier: 1, title: 'A fact', body: 'The room agreed on the record.',
    source_message_id: 'msg-1', valid_from: '2026-10-01T00:00:00.000Z', ...over,
  };
}

test('proposeItem stores review_state pending, including a tier-3 skill, and does not touch memory_fts', async () => {
  const { db, close } = await start();
  try {
    const ftsBefore = (await db.prepare('SELECT count(*) n FROM memory_fts').first<{ n: number }>())!.n;
    const item = await proposeItem(db, 'agent:grok', input());
    assert.equal(item.review_state, 'pending');
    assert.equal(item.proposed_by, 'agent:grok');
    assert.equal(item.valid_until, null);
    const stored = await db.prepare('SELECT review_state, proposed_by, valid_until FROM memory_items WHERE id=?').bind(item.id).first<{ review_state: string; proposed_by: string; valid_until: string | null }>();
    assert.equal(stored!.review_state, 'pending');
    assert.equal(stored!.proposed_by, 'agent:grok');
    assert.equal(stored!.valid_until, null);
    await db.prepare(`INSERT INTO memory_items(id,room_id,kind,tier,title,body,source_message_id,proposed_by,valid_from,created_at)
      VALUES ('default-state','room_main','decision',2,'Title','Body text','msg-1','agent:grok','2026-10-01T00:00:00.000Z','2026-10-02T00:00:00.000Z')`).all();
    assert.equal((await db.prepare("SELECT review_state FROM memory_items WHERE id='default-state'").first<{ review_state: string }>())!.review_state, 'pending');
    const skill = await proposeItem(db, 'agent:grok', input({ kind: 'skill', tier: 3, title: 'Post a message', body: 'Use the room post tool.' }));
    assert.equal(skill.kind, 'skill');
    assert.equal(skill.tier, 3);
    assert.equal(skill.review_state, 'pending');
    await assert.rejects(() => proposeItem(db, 'agent:grok', input({ kind: 'fact', tier: 3, title: 'Not a skill' })), (err: unknown) => err instanceof Fault && err.code === 'INVALID_INPUT');
    assert.equal((await db.prepare('SELECT count(*) n FROM memory_fts').first<{ n: number }>())!.n, ftsBefore);
    assert.equal((await db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND tbl_name='memory_items'").first<{ n: number }>())!.n, 0);
  } finally { await close(); }
});

test('validView returns approved items only unless includePending is set', async () => {
  const { db, close } = await start();
  try {
    const pending = await proposeItem(db, 'agent:grok', input({ title: 'Still proposed', body: 'Not reviewed yet.' }));
    const approved = await proposeItem(db, 'agent:grok', input({ kind: 'decision', tier: 2, title: 'Ship W2', body: 'Items stay pending until review.' }));
    await db.prepare("UPDATE memory_items SET review_state='approved' WHERE id=?").bind(approved.id).all();
    const rejected = await proposeItem(db, 'agent:grok', input({ title: 'Dropped idea', body: 'Reviewer said no.' }));
    await db.prepare("UPDATE memory_items SET review_state='rejected' WHERE id=?").bind(rejected.id).all();
    const view = await validView(db, 'room_main', { at: AT });
    assert.deepEqual(view.map(item => item.id), [approved.id]);
    const withPending = await validView(db, 'room_main', { at: AT, includePending: true });
    assert.deepEqual(withPending.map(item => item.id).sort(), [approved.id, pending.id].sort());
    assert.ok(withPending.every(item => item.review_state !== 'rejected'));
    const decisions = await validView(db, 'room_main', { at: AT, kinds: ['decision'] });
    assert.deepEqual(decisions.map(item => item.id), [approved.id]);
    assert.deepEqual(await validView(db, 'room_main', { at: AT, kinds: ['skill'] }), []);
  } finally { await close(); }
});

test('proposeSupersede writes a pending edge and closes nothing', async () => {
  const { db, close } = await start();
  try {
    const older = await proposeItem(db, 'agent:grok', input({ title: 'Old decision', kind: 'decision', tier: 2, body: 'Use pending edges.' }));
    const newer = await proposeItem(db, 'agent:grok', input({ title: 'New decision', kind: 'decision', tier: 2, body: 'Still do not close the old row.', valid_from: '2026-10-02T00:00:00.000Z' }));
    await db.prepare("UPDATE memory_items SET review_state='approved' WHERE id=?").bind(older.id).all();
    const before = await db.prepare('SELECT * FROM memory_items WHERE id=?').bind(older.id).first();
    const edge = await proposeSupersede(db, 'agent:grok', older.id, newer.id);
    assert.equal(edge.type, 'SUPERSEDED_BY');
    assert.equal(edge.review_state, 'pending');
    assert.equal(edge.src_id, older.id);
    assert.equal(edge.dst_id, newer.id);
    assert.equal(edge.proposed_by, 'agent:grok');
    const after = await db.prepare('SELECT * FROM memory_items WHERE id=?').bind(older.id).first();
    assert.deepEqual(after, before);
    assert.equal((after as { valid_until: string | null }).valid_until, null);
    assert.equal((after as { review_state: string }).review_state, 'approved');
    const visible = await validView(db, 'room_main', { at: AT });
    assert.ok(visible.some(item => item.id === older.id));
    await assert.rejects(() => proposeSupersede(db, 'agent:grok', older.id, older.id), (err: unknown) => err instanceof Fault && err.code === 'INVALID_INPUT');
    const third = await proposeItem(db, 'agent:grok', input({ title: 'Third', body: 'Cycle check.', valid_from: '2026-10-03T00:00:00.000Z' }));
    await proposeSupersede(db, 'agent:grok', newer.id, third.id);
    await assert.rejects(() => proposeSupersede(db, 'agent:grok', third.id, older.id), (err: unknown) => err instanceof Fault && err.code === 'INVALID_INPUT');
    assert.equal((await db.prepare('SELECT valid_until FROM memory_items WHERE id=?').bind(older.id).first<{ valid_until: string | null }>())!.valid_until, null);
    assert.equal((await db.prepare("SELECT count(*) n FROM memory_edges WHERE src_id=? AND dst_id=?").bind(third.id, older.id).first<{ n: number }>())!.n, 0);
  } finally { await close(); }
});

test('CHECK constraints reject a kind outside decision, fact, and skill', async () => {
  const { db, close } = await start();
  try {
    const badKind = db.prepare(`INSERT INTO memory_items(id,room_id,kind,tier,title,body,source_message_id,proposed_by,valid_from,created_at)
      VALUES ('bad-kind','room_main','episode',0,'Title','Body text','msg-1','agent:grok','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z')`).all();
    await assert.rejects(badKind, (err: unknown) => err instanceof Error && /CHECK constraint failed/i.test(err.message));
    const badTier = db.prepare(`INSERT INTO memory_items(id,room_id,kind,tier,title,body,source_message_id,proposed_by,valid_from,created_at)
      VALUES ('bad-tier','room_main','fact',4,'Title','Body text','msg-1','agent:grok','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z')`).all();
    await assert.rejects(badTier, (err: unknown) => err instanceof Error && /CHECK constraint failed/i.test(err.message));
    const badState = db.prepare(`INSERT INTO memory_items(id,room_id,kind,tier,title,body,source_message_id,proposed_by,review_state,valid_from,created_at)
      VALUES ('bad-state','room_main','fact',1,'Title','Body text','msg-1','agent:grok','open','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z')`).all();
    await assert.rejects(badState, (err: unknown) => err instanceof Error && /CHECK constraint failed/i.test(err.message));
    const anchor = await proposeItem(db, 'agent:grok', input());
    const other = await proposeItem(db, 'agent:grok', input({ title: 'Other', body: 'Edge endpoint.' }));
    const badEdge = db.prepare(`INSERT INTO memory_edges(id,src_id,dst_id,type,proposed_by,created_at)
      VALUES ('bad-edge',?,?,'SUPERSEDES','agent:grok','2026-10-03T00:00:00.000Z')`).bind(anchor.id, other.id).all();
    await assert.rejects(badEdge, (err: unknown) => err instanceof Error && /CHECK constraint failed/i.test(err.message));
    assert.equal((await db.prepare("SELECT count(*) n FROM memory_items WHERE id IN ('bad-kind','bad-tier','bad-state')").first<{ n: number }>())!.n, 0);
  } finally { await close(); }
});

test('titles and bodies that look like secrets are rejected and not stored', async () => {
  const { db, close } = await start();
  try {
    const hex = 'ab'.repeat(20);
    const b64 = 'Aa1+/' + 'Bb'.repeat(20);
    const secrets = [
      input({ body: 'prefix sk-testfakevalue in the note' }),
      input({ title: 'ghp_testfakevalue' }),
      input({ body: 'slack xoxb-testfake' }),
      input({ body: 'aws AKIATESTFAKEKEY0001' }),
      input({ body: '-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----' }),
      input({ body: 'password=' + hex }),
      input({ title: 'token = "' + b64 + '"' }),
      input({ body: 'api_key=' + hex }),
    ];
    for (const sample of secrets) {
      await assert.rejects(() => proposeItem(db, 'agent:grok', sample), (err: unknown) => err instanceof Fault && err.code === 'INVALID_INPUT' && !err.message.includes(hex) && !err.message.includes('sk-'));
    }
    assert.equal((await db.prepare('SELECT count(*) n FROM memory_items').first<{ n: number }>())!.n, 0);
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const kept = await proposeItem(db, 'agent:grok', input({ body: 'Shipped in commit ' + sha + ' with key=required_always.' }));
    assert.equal(kept.review_state, 'pending');
    assert.ok(kept.body.includes(sha));
    await assert.rejects(() => proposeItem(db, 'agent:grok', input({ title: 'x'.repeat(201) })), (err: unknown) => err instanceof Fault && err.code === 'INVALID_INPUT');
    await assert.rejects(() => proposeItem(db, 'agent:grok', input({ body: 'y'.repeat(8193) })), (err: unknown) => err instanceof Fault && err.code === 'INVALID_INPUT');
    const maxBody = await proposeItem(db, 'agent:grok', input({ title: 't'.repeat(200), body: 'y'.repeat(8192) }));
    assert.equal(maxBody.title.length, 200);
    assert.equal(maxBody.body.length, 8192);
  } finally { await close(); }
});

test('validView filters on valid_from and valid_until against at', async () => {
  const { db, close } = await start();
  try {
    const open = await proposeItem(db, 'agent:grok', input({ title: 'Open', body: 'Valid now.', valid_from: '2026-10-01T00:00:00.000Z' }));
    const startsAt = await proposeItem(db, 'agent:grok', input({ title: 'Starts at', body: 'Boundary include.', valid_from: AT }));
    const future = await proposeItem(db, 'agent:grok', input({ title: 'Future', body: 'Not yet.', valid_from: '2026-11-01T00:00:00.000Z' }));
    const endsAt = await proposeItem(db, 'agent:grok', input({ title: 'Ends at', body: 'Closed at the instant.', valid_from: '2026-01-01T00:00:00.000Z' }));
    const endsLater = await proposeItem(db, 'agent:grok', input({ title: 'Ends later', body: 'Still open.', valid_from: '2026-01-01T00:00:00.000Z' }));
    const otherRoom = await proposeItem(db, 'agent:grok', input({ room_id: 'room_other', source_message_id: 'msg-2', title: 'Elsewhere', body: 'Other room.' }));
    await db.batch([
      db.prepare("UPDATE memory_items SET review_state='approved' WHERE id=?").bind(open.id),
      db.prepare("UPDATE memory_items SET review_state='approved' WHERE id=?").bind(startsAt.id),
      db.prepare("UPDATE memory_items SET review_state='approved' WHERE id=?").bind(future.id),
      db.prepare("UPDATE memory_items SET review_state='approved', valid_until=? WHERE id=?").bind(AT, endsAt.id),
      db.prepare("UPDATE memory_items SET review_state='approved', valid_until=? WHERE id=?").bind('2026-12-01T00:00:00.000Z', endsLater.id),
      db.prepare("UPDATE memory_items SET review_state='approved' WHERE id=?").bind(otherRoom.id),
    ]);
    const ids = (await validView(db, 'room_main', { at: AT })).map(item => item.id);
    assert.deepEqual(ids, [endsLater.id, open.id, startsAt.id]);
    assert.ok(!ids.includes(future.id));
    assert.ok(!ids.includes(endsAt.id));
    assert.deepEqual((await validView(db, 'room_other', { at: AT })).map(item => item.id), [otherRoom.id]);
    const earlier = (await validView(db, 'room_main', { at: '2026-09-01T00:00:00.000Z' })).map(item => item.id);
    assert.deepEqual(earlier, [endsAt.id, endsLater.id]);
  } finally { await close(); }
});
