import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { migrate } from '../scripts/local-harness.ts';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import { Fault } from '../src/server/contracts.ts';
import type { Database } from '../src/server/db.ts';
import { experienceDigest, experienceView, judgeExperience, observeExperience, proposeExperience, type ExperienceEntry } from '../src/server/experience.ts';

// W6 experience ledger: propose -> observe -> independent keep/revert; nothing auto-applies.
async function start(): Promise<{ db: Database; close: () => Promise<void> }> {
  const d1 = await cloneD1(20);
  const mf = new Miniflare({
    modules: true, script: 'export default { async fetch() { return new Response(null, { status: 204 }); } }',
    compatibilityDate: '2026-07-28', d1Databases: { DB: D1_TEMPLATE_NAME }, d1Persist: d1.dir, cf: false,
  } as ConstructorParameters<typeof Miniflare>[0]);
  await mf.ready;
  const db = await mf.getD1Database('DB') as Database;
  await migrate(db, 20);
  await db.batch([
    db.prepare("INSERT INTO rooms(id) VALUES ('room_main')"),
    db.prepare("INSERT INTO rooms(id) VALUES ('room_other')"),
    ...['agent:grok', 'agent:dots', 'agent:muse', 'agent:egg'].map(p => db.prepare('INSERT INTO principals(id) VALUES (?)').bind(p)),
    db.prepare("INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES ('m-src','room_main','agent:grok','proposal','text','2026-10-22T00:00:00.000Z')"),
    db.prepare("INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES ('m-out','room_main','agent:grok','outcome evidence','text','2026-10-22T01:00:00.000Z')"),
    db.prepare("INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES ('m-far','room_other','agent:grok','elsewhere','text','2026-10-22T01:00:00.000Z')"),
    db.prepare("INSERT INTO memory_reviewers(principal_id, added_at) VALUES ('agent:dots','2026-10-22T00:00:00.000Z')"),
  ]);
  return { db, close: () => mf.dispose().then(d1.cleanup) };
}

const base = { room_id: 'room_main', component: 'tool_guidance', change: 'Read unread before posting a status claim.', prediction: 'Fewer stale-watch corrections per day.', source_message_id: 'm-src' };
const refused = (e: unknown) => e instanceof Fault && e.code === 'INVALID_INPUT';

async function observed(db: Database, proposer = 'agent:grok', observer = 'agent:grok'): Promise<ExperienceEntry> {
  const e = await proposeExperience(db, proposer, base);
  return observeExperience(db, observer, e.id, 'Zero stale corrections in 24h (was 2).', 'm-out');
}

test('W6 propose stores a proposed entry; component, room evidence and secrets are checked', async () => {
  const { db, close } = await start();
  try {
    const e = await proposeExperience(db, 'agent:grok', base);
    assert.equal(e.state, 'proposed'); assert.equal(e.outcome, null); assert.equal(e.proposed_by, 'agent:grok');
    await assert.rejects(proposeExperience(db, 'agent:grok', { ...base, component: 'kernel' }), refused);
    await assert.rejects(proposeExperience(db, 'agent:grok', { ...base, source_message_id: 'm-far' }), refused);
    await assert.rejects(proposeExperience(db, 'agent:grok', { ...base, change: 'use token=ghp_' + 'a'.repeat(40) }), refused);
    assert.deepEqual(await experienceView(db, 'room_main'), [], 'library shows kept only');
  } finally { await close(); }
});

test('W6 observe records the outcome once and requires evidence in the same room', async () => {
  const { db, close } = await start();
  try {
    const e = await proposeExperience(db, 'agent:grok', base);
    await assert.rejects(observeExperience(db, 'agent:grok', e.id, 'x', 'm-far'), refused);
    const o = await observeExperience(db, 'agent:muse', e.id, 'Zero stale corrections.', 'm-out');
    assert.equal(o.state, 'observed'); assert.equal(o.observed_by, 'agent:muse');
    await assert.rejects(observeExperience(db, 'agent:muse', e.id, 'rewrite history', 'm-out'), refused);
    await assert.rejects(db.prepare("UPDATE experience_entries SET outcome='edited' WHERE id=?").bind(e.id).all(), /immutable/);
    await assert.rejects(db.prepare("UPDATE experience_entries SET prediction='moved goalpost' WHERE id=?").bind(e.id).all(), /immutable/);
  } finally { await close(); }
});

test('W6 keep needs a listed reviewer who is neither proposer nor observer, and an exact digest', async () => {
  const { db, close } = await start();
  try {
    const e = await observed(db);
    const digest = await experienceDigest(e);
    await assert.rejects(judgeExperience(db, 'agent:grok', e.id, 'keep', 'self', digest), refused, 'proposer cannot keep');
    await assert.rejects(judgeExperience(db, 'agent:muse', e.id, 'keep', 'not listed', digest), refused, 'unlisted cannot keep');
    await assert.rejects(judgeExperience(db, 'agent:dots', e.id, 'keep', 'stale digest', 'f'.repeat(64)), refused);
    const k = await judgeExperience(db, 'agent:dots', e.id, 'keep', 'Evidence m-out matches prediction.', digest);
    assert.equal(k.state, 'kept'); assert.equal(k.verdict_by, 'agent:dots'); assert.equal(k.verdict_digest, digest);
    assert.deepEqual((await experienceView(db, 'room_main')).map(x => x.id), [e.id]);
    await assert.rejects(judgeExperience(db, 'agent:dots', e.id, 'revert', 'flip', digest), refused, 'final');
    await assert.rejects(db.prepare("UPDATE experience_entries SET state='reverted' WHERE id=?").bind(e.id).all(), /immutable|independent listed reviewer/);
    await assert.rejects(db.prepare('DELETE FROM experience_entries WHERE id=?').bind(e.id).all(), /append-only/);
  } finally { await close(); }
});

test('W6 the observer cannot judge (MASS), even when listed; a listed third party can revert', async () => {
  const { db, close } = await start();
  try {
    const e = await observed(db, 'agent:grok', 'agent:dots');
    const digest = await experienceDigest(e);
    await assert.rejects(judgeExperience(db, 'agent:dots', e.id, 'keep', 'own observation', digest), refused);
    await db.prepare("INSERT INTO memory_reviewers(principal_id, added_at) VALUES ('agent:egg','2026-10-22T00:00:00.000Z')").all();
    const r = await judgeExperience(db, 'agent:egg', e.id, 'revert', 'Outcome does not show the predicted effect.', digest);
    assert.equal(r.state, 'reverted');
    assert.deepEqual(await experienceView(db, 'room_main'), []);
    assert.equal((await experienceView(db, 'room_main', { states: ['reverted'] })).length, 1);
  } finally { await close(); }
});

test('W6 direct SQL cannot skip observe or bypass the independent-reviewer trigger', async () => {
  const { db, close } = await start();
  try {
    const p = await proposeExperience(db, 'agent:grok', base);
    await assert.rejects(db.prepare("UPDATE experience_entries SET state='kept', verdict_by='agent:dots' WHERE id=?").bind(p.id).all());
    const o = await observeExperience(db, 'agent:grok', p.id, 'done', 'm-out');
    await assert.rejects(db.prepare("UPDATE experience_entries SET state='kept', verdict_by='agent:grok' WHERE id=?").bind(o.id).all(), /independent listed reviewer/);
    await assert.rejects(db.prepare("UPDATE experience_entries SET state='kept', verdict_by='agent:muse' WHERE id=?").bind(o.id).all(), /independent listed reviewer/);
  } finally { await close(); }
});
