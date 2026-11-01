import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { migrate } from '../scripts/local-harness.ts';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import { briefGetSchema, Fault } from '../src/server/contracts.ts';
import type { Database } from '../src/server/db.ts';
import { Workroom } from '../src/server/domain.ts';
import { experienceDigest, judgeExperience, observeExperience, proposeExperience, type ExperienceEntry } from '../src/server/experience.ts';
import { proposeItem, proposeSupersede, type MemoryItem, type ProposeItemInput } from '../src/server/memory-items.ts';
import { edgeContentDigest, itemContentDigest, reviewEdge, reviewItem } from '../src/server/memory-review.ts';
import { DECISION_LIMIT, roomBrief } from '../src/server/room-brief.ts';
import { skillGrade } from '../src/server/skill-grade.ts';

// OCG-W W8. Same Miniflare harness as tests/ocgw-pack.test.ts. Reviewers are seeded only here.
const ROOM = 'room_main';
const OTHER = 'room_other';
const T0 = '2026-10-01T00:00:00.000Z';
const BETWEEN = '2026-10-10T00:00:00.000Z';
const T1 = '2026-10-20T00:00:00.000Z';
const AT = '2026-10-23T00:00:00.000Z';

async function start(): Promise<{ db: Database; close: () => Promise<void> }> {
  const d1 = await cloneD1(25);
  const mf = new Miniflare({
    modules: true,
    script: 'export default { async fetch() { return new Response(null, { status: 204 }); } }',
    compatibilityDate: '2026-07-28',
    d1Databases: { DB: D1_TEMPLATE_NAME }, d1Persist: d1.dir,
    cf: false,
  } as ConstructorParameters<typeof Miniflare>[0]);
  await mf.ready;
  const db = await mf.getD1Database('DB') as Database;
  await migrate(db, 25);
  await db.batch([
    db.prepare("INSERT INTO rooms(id) VALUES ('room_main')"),
    db.prepare("INSERT INTO rooms(id) VALUES ('room_other')"),
    db.prepare("INSERT INTO principals(id) VALUES ('agent:grok')"),
    db.prepare("INSERT INTO principals(id) VALUES ('agent:dots')"),
    db.prepare("INSERT INTO memory_reviewers(principal_id, added_at) VALUES ('agent:dots', '2026-10-22T00:00:00.000Z')"),
  ]);
  return { db, close: () => mf.dispose().then(d1.cleanup) };
}

function input(over: Partial<ProposeItemInput> = {}): ProposeItemInput {
  return {
    room_id: ROOM, kind: 'decision', tier: 2, title: 'A decision', body: 'The room agreed.',
    source_message_id: 'msg-1', valid_from: T0, ...over,
  };
}

async function say(db: Database, id: string, text: string, createdAt: string, room = ROOM): Promise<void> {
  await db.prepare('INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES (?,?,?,?,?,?)')
    .bind(id, room, 'agent:grok', text, 'text', createdAt).all();
}

async function approve(db: Database, item: MemoryItem): Promise<void> {
  await reviewItem(db, 'agent:dots', item.id, 'approve', 'Recorded.', await itemContentDigest(item));
}

async function keep(db: Database, over: Partial<ProposeItemInput>): Promise<MemoryItem> {
  const item = await proposeItem(db, 'agent:grok', input(over));
  await approve(db, item);
  return item;
}

async function keepExperience(db: Database, change: string, room = ROOM, source = 'm-src', outcome = 'm-out'): Promise<ExperienceEntry> {
  const proposed = await proposeExperience(db, 'agent:grok', {
    room_id: room, component: 'memory', change, prediction: 'Fewer misses.', source_message_id: source,
  });
  const observed = await observeExperience(db, 'agent:grok', proposed.id, 'Observed in the room.', outcome);
  return judgeExperience(db, 'agent:dots', proposed.id, 'keep', 'Keep the recorded change.', await experienceDigest(observed));
}

function ids(rows: { id: string }[]): string[] {
  return rows.map(row => row.id);
}

function refused(err: unknown): boolean {
  return err instanceof Fault && err.code === 'INVALID_INPUT';
}

function forbidden(err: unknown): boolean {
  return err instanceof Fault && err.code === 'FORBIDDEN' && err.status === 403;
}

test('briefGetSchema defaults max_chars to 4000 and rejects a budget outside 1000..8000', () => {
  const parsed = briefGetSchema.safeParse({ schema_version: '1', room: ROOM });
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.max_chars, 4000);
  assert.equal(briefGetSchema.safeParse({ schema_version: '1', room: ROOM, max_chars: 1000 }).success, true);
  assert.equal(briefGetSchema.safeParse({ schema_version: '1', room: ROOM, max_chars: 8000 }).success, true);
  assert.equal(briefGetSchema.safeParse({ schema_version: '1', room: ROOM, max_chars: 999 }).success, false);
  assert.equal(briefGetSchema.safeParse({ schema_version: '1', room: ROOM, max_chars: 8001 }).success, false);
  assert.equal(briefGetSchema.safeParse({ schema_version: '1', room: ROOM, max_chars: 4000.5 }).success, false);
  assert.equal(briefGetSchema.safeParse({ schema_version: '1', room: ROOM, at: '2026-10-23T09:00:00+09:00' }).success, true);
  assert.equal(briefGetSchema.safeParse({ schema_version: '1', room: ROOM, at: '2026-10-23T00:00:00Z' }).success, true);
  assert.equal(briefGetSchema.safeParse({ schema_version: '1', room: ROOM, at: '2026-10-23T00:00:00' }).success, false);
  assert.equal(briefGetSchema.safeParse({ schema_version: '1', room: ROOM, body: 'x' }).success, false);
});

test('a pending decision never appears and an approved one keeps source_version', async () => {
  const { db, close } = await start();
  try {
    await say(db, 'msg-new', 'source new', T1);
    await say(db, 'msg-old', 'source old', T0);
    await say(db, 'msg-pend', 'source pending', T1);
    await say(db, 'msg-fact', 'source fact', T0);
    const newer = await keep(db, { id: 'dec-new', title: 'Approved new decision', body: 'BODY_ONLY_NEW stays in the item.', source_message_id: 'msg-new', valid_from: T1 });
    const older = await keep(db, { id: 'dec-old', title: 'Approved old decision', body: 'BODY_ONLY_OLD stays in the item.', source_message_id: 'msg-old', valid_from: T0 });
    await proposeItem(db, 'agent:grok', input({ id: 'dec-pend', title: 'Pending decision', body: 'BODY_ONLY_PENDING stays out.', source_message_id: 'msg-pend', valid_from: T1 }));
    await keep(db, { id: 'fact-1', kind: 'fact', tier: 1, title: 'A fact', body: 'BODY_ONLY_FACT stays out.', source_message_id: 'msg-fact', valid_from: T0 });
    const brief = await roomBrief(db, ROOM, { at: AT, maxChars: 8000 });
    assert.equal(brief.at, AT);
    assert.equal(brief.room, ROOM);
    assert.equal(brief.truncated, false);
    assert.deepEqual(ids(brief.decisions), ['dec-new', 'dec-old']);
    assert.deepEqual(ids(brief.skills), []);
    const top = brief.decisions[0];
    assert.ok(top);
    assert.equal(top.title, 'Approved new decision');
    assert.equal(top.valid_from, T1);
    assert.equal(top.valid_until, null);
    assert.equal(top.source_message_id, 'msg-new');
    assert.equal(top.source_version, newer.source_version);
    assert.equal(top.source_version, 1);
    assert.equal(brief.decisions[1]?.source_version, older.source_version);
    assert.deepEqual(Object.keys(top), ['id', 'title', 'valid_from', 'valid_until', 'source_message_id', 'source_version', 'source_version_basis']);
    const text = JSON.stringify(brief);
    assert.equal(text.includes('BODY_ONLY_'), false);
    assert.equal(text.includes('Pending decision'), false);
    assert.equal(text.includes('dec-pend'), false);
    assert.equal(text.includes('fact-1'), false);
    assert.equal(brief.notes.some(note => note.includes('untrusted')), true);
  } finally { await close(); }
});

test('a superseded decision is excluded, and at before the supersede shows the old one', async () => {
  const { db, close } = await start();
  try {
    await say(db, 'msg-old', 'source old', T0);
    await say(db, 'msg-new', 'source new', T1);
    await say(db, 'msg-pend', 'source pending', T0);
    const old = await keep(db, { id: 'dec-old', title: 'Old gateway rule', body: 'OLD_BODY_SENTINEL stays out.', source_message_id: 'msg-old', valid_from: T0 });
    const neu = await keep(db, { id: 'dec-new', title: 'New gateway rule', body: 'NEW_BODY_SENTINEL stays out.', source_message_id: 'msg-new', valid_from: T1 });
    await proposeItem(db, 'agent:grok', input({ id: 'dec-pend', title: 'Pending gateway rule', body: 'Still pending.', source_message_id: 'msg-pend', valid_from: T0 }));
    const edge = await proposeSupersede(db, 'agent:grok', old.id, neu.id);
    await reviewEdge(db, 'agent:dots', edge.id, 'approve', 'Superseded.', await edgeContentDigest(edge));
    const closed = await db.prepare('SELECT valid_until FROM memory_items WHERE id=?').bind(old.id).first<{ valid_until: string }>();
    assert.equal(closed?.valid_until, T1);
    const later = await roomBrief(db, ROOM, { at: '2026-10-23T09:00:00+09:00', maxChars: 4000 });
    assert.equal(later.at, AT);
    assert.deepEqual(ids(later.decisions), ['dec-new']);
    assert.equal(later.decisions[0]?.source_version, neu.source_version);
    assert.equal(JSON.stringify(later).includes('OLD_BODY_SENTINEL'), false);
    assert.equal(JSON.stringify(later).includes('Pending gateway rule'), false);
    const earlier = await roomBrief(db, ROOM, { at: BETWEEN, maxChars: 4000 });
    assert.equal(earlier.at, BETWEEN);
    assert.deepEqual(ids(earlier.decisions), ['dec-old']);
    assert.equal(earlier.decisions[0]?.title, 'Old gateway rule');
    assert.equal(earlier.decisions[0]?.valid_until, T1);
    assert.equal(earlier.decisions[0]?.source_version, old.source_version);
    assert.equal(JSON.stringify(earlier).includes('OLD_BODY_SENTINEL'), false);
    assert.equal(JSON.stringify(earlier).includes('dec-new'), false);
    assert.equal(JSON.stringify(earlier).includes('dec-pend'), false);
  } finally { await close(); }
});

test('a skill grade letter matches skillGrade()', async () => {
  const { db, close } = await start();
  try {
    await say(db, 'msg-skill', 'skill source', T0);
    const high = await keep(db, { id: 'skill-high', kind: 'skill', tier: 3, title: 'Close the loop', body: 'Named reviewer. Declared grade ignored.', source_message_id: 'msg-skill', valid_from: T0 });
    const low = await keep(db, { id: 'skill-low', kind: 'skill', tier: 1, title: 'A small skill', body: 'Still a skill.', source_message_id: 'msg-skill', valid_from: T1 });
    const pending = await proposeItem(db, 'agent:grok', input({ id: 'skill-pend', kind: 'skill', tier: 3, title: 'Pending skill', body: 'Not approved.', source_message_id: 'msg-skill', valid_from: T0 }));
    const rejected = await proposeItem(db, 'agent:grok', input({ id: 'skill-no', kind: 'skill', tier: 2, title: 'Rejected skill', body: 'No.', source_message_id: 'msg-skill', valid_from: T0 }));
    await reviewItem(db, 'agent:dots', rejected.id, 'reject', 'No.', await itemContentDigest(rejected));
    const brief = await roomBrief(db, ROOM, { at: AT, maxChars: 8000 });
    assert.deepEqual(ids(brief.skills), ['skill-high', 'skill-low']);
    assert.equal(JSON.stringify(brief).includes(pending.id), false);
    assert.equal(JSON.stringify(brief).includes(rejected.id), false);
    for (const skill of brief.skills) {
      const grade = await skillGrade(db, skill.id);
      assert.equal(skill.grade, grade.letter);
      assert.equal(skill.grade, 'F');
    }
    assert.equal(brief.skills[0]?.tier, high.tier);
    assert.equal(brief.skills[1]?.tier, low.tier);
    assert.equal(brief.skills[0]?.title, 'Close the loop');
  } finally { await close(); }
});

test('review_queue counts pending items, pending edges, and observed experience with no verdict', async () => {
  const { db, close } = await start();
  try {
    await say(db, 'msg-main', 'main source', T0);
    await say(db, 'm-src', 'proposal', T0);
    await say(db, 'm-out', 'outcome', T1);
    await say(db, 'msg-other', 'other source', T0, OTHER);
    await say(db, 'm-far', 'other proposal', T0, OTHER);
    await say(db, 'm-far-out', 'other outcome', T1, OTHER);
    await proposeItem(db, 'agent:grok', input({ id: 'pend-main', title: 'Pending main', body: 'Waiting.', source_message_id: 'msg-main', valid_from: T1 }));
    const old = await keep(db, { id: 'old-main', title: 'Approved old', body: 'Old.', source_message_id: 'msg-main', valid_from: T0 });
    const neu = await keep(db, { id: 'new-main', title: 'Approved new', body: 'New.', source_message_id: 'msg-main', valid_from: T1 });
    await proposeSupersede(db, 'agent:grok', old.id, neu.id);
    await proposeItem(db, 'agent:grok', input({ id: 'pend-other', room_id: OTHER, title: 'Pending other', body: 'Elsewhere.', source_message_id: 'msg-other', valid_from: T0 }));
    await proposeItem(db, 'agent:grok', input({ id: 'edge-other-old', room_id: OTHER, title: 'Other old', body: 'Elsewhere.', source_message_id: 'msg-other', valid_from: T0 }));
    await proposeItem(db, 'agent:grok', input({ id: 'edge-other-new', room_id: OTHER, title: 'Other new', body: 'Elsewhere.', source_message_id: 'msg-other', valid_from: T1 }));
    await proposeSupersede(db, 'agent:grok', 'edge-other-old', 'edge-other-new');
    await proposeExperience(db, 'agent:grok', { room_id: ROOM, component: 'scripts', change: 'Only proposed.', prediction: 'No verdict yet.', source_message_id: 'm-src' });
    const proposedObserved = await proposeExperience(db, 'agent:grok', { room_id: ROOM, component: 'tool_guidance', change: 'Awaiting a verdict.', prediction: 'A reviewer will judge it.', source_message_id: 'm-src' });
    await observeExperience(db, 'agent:grok', proposedObserved.id, 'Seen once.', 'm-out');
    const far = await proposeExperience(db, 'agent:grok', { room_id: OTHER, component: 'plugins', change: 'FOREIGN_OBSERVED', prediction: 'Stays in the other room.', source_message_id: 'm-far' });
    await observeExperience(db, 'agent:grok', far.id, 'Seen there.', 'm-far-out');
    const change = '가'.repeat(199) + 'YZ';
    const kept = await keepExperience(db, change);
    const brief = await roomBrief(db, ROOM, { at: AT, maxChars: 8000 });
    assert.deepEqual(brief.review_queue, { pending_items: 1, pending_edges: 1, experience_awaiting_verdict: 1, pending_folds: 0 });
    assert.deepEqual(ids(brief.decisions), ['new-main', 'old-main']);
    assert.equal(JSON.stringify(brief).includes('pend-main'), false);
    assert.equal(JSON.stringify(brief).includes('pend-other'), false);
    assert.equal(JSON.stringify(brief).includes('FOREIGN_OBSERVED'), false);
    assert.deepEqual(ids(brief.recent_kept_experience), [kept.id]);
    const shown = brief.recent_kept_experience[0];
    assert.ok(shown);
    assert.equal(shown.component, 'memory');
    assert.equal([...shown.change].length, 200);
    assert.equal(shown.change, '가'.repeat(199) + 'Y');
    assert.equal(brief.truncated, false);
  } finally { await close(); }
});

test('items from another room never appear', async () => {
  const { db, close } = await start();
  try {
    await say(db, 'msg-main', 'main source', T0);
    await say(db, 'msg-other', 'other source', T0, OTHER);
    await say(db, 'm-src', 'proposal', T0);
    await say(db, 'm-out', 'outcome', T1);
    await say(db, 'm-far', 'other proposal', T0, OTHER);
    await say(db, 'm-far-out', 'other outcome', T1, OTHER);
    await keep(db, { id: 'main-decision', title: 'Main decision', body: 'Main body.', source_message_id: 'msg-main', valid_from: T1 });
    await keep(db, { id: 'other-decision', room_id: OTHER, title: 'Other decision', body: 'Other body.', source_message_id: 'msg-other', valid_from: T1 });
    await keep(db, { id: 'main-skill', kind: 'skill', tier: 3, title: 'Main skill', body: 'Main procedure.', source_message_id: 'msg-main', valid_from: T0 });
    await keep(db, { id: 'other-skill', room_id: OTHER, kind: 'skill', tier: 3, title: 'Other skill', body: 'Other procedure.', source_message_id: 'msg-other', valid_from: T0 });
    await proposeItem(db, 'agent:grok', input({ id: 'main-pending', title: 'Main pending', body: 'Waiting.', source_message_id: 'msg-main', valid_from: T0 }));
    await proposeItem(db, 'agent:grok', input({ id: 'other-pending', room_id: OTHER, title: 'Other pending', body: 'Waiting.', source_message_id: 'msg-other', valid_from: T0 }));
    await keepExperience(db, 'main-kept-change');
    await keepExperience(db, 'other-kept-change', OTHER, 'm-far', 'm-far-out');
    const otherObserved = await proposeExperience(db, 'agent:grok', { room_id: OTHER, component: 'guardrails', change: 'other-awaiting', prediction: 'Stays there.', source_message_id: 'm-far' });
    await observeExperience(db, 'agent:grok', otherObserved.id, 'Seen there.', 'm-far-out');
    await db.batch([
      db.prepare(`INSERT INTO tasks(id,room_id,creator_id,owner_id,spec_json,state,version,created_at_ms,updated_at_ms) VALUES ('task-open','room_main','agent:grok','agent:grok','{"goal":"Ship the brief"}','open',1,1,30)`),
      db.prepare(`INSERT INTO task_leases(task_id,holder_id,lease_epoch,expires_at_ms) VALUES ('task-open','agent:grok',1,9999999999999)`),
      db.prepare(`INSERT INTO tasks(id,room_id,creator_id,spec_json,state,version,created_at_ms,updated_at_ms) VALUES ('task-done','room_main','agent:grok','{"goal":"Already done"}','done',1,1,40)`),
      db.prepare(`INSERT INTO tasks(id,room_id,creator_id,spec_json,state,version,created_at_ms,updated_at_ms) VALUES ('task-cancel','room_main','agent:grok','{"goal":"Canceled work"}','canceled',1,1,50)`),
      db.prepare(`INSERT INTO tasks(id,room_id,creator_id,owner_id,spec_json,state,version,created_at_ms,updated_at_ms) VALUES ('task-other','room_other','agent:grok','agent:grok','{"goal":"Other room task"}','in_progress',1,1,60)`),
      db.prepare(`INSERT INTO task_leases(task_id,holder_id,lease_epoch,expires_at_ms) VALUES ('task-other','agent:dots',2,9999999999999)`),
    ]);
    const main = await roomBrief(db, ROOM, { at: AT, maxChars: 8000 });
    const other = await roomBrief(db, OTHER, { at: AT, maxChars: 8000 });
    assert.equal(main.truncated, false);
    assert.equal(other.truncated, false);
    assert.deepEqual(ids(main.decisions), ['main-decision']);
    assert.deepEqual(ids(main.skills), ['main-skill']);
    assert.equal(main.skills[0]?.grade, (await skillGrade(db, 'main-skill')).letter);
    assert.deepEqual(main.recent_kept_experience.map(entry => entry.change), ['main-kept-change']);
    assert.deepEqual(main.open_tasks, [{ id: 'task-open', goal: 'Ship the brief', state: 'open', owner_id: 'agent:grok', holder_id: 'agent:grok' }]);
    assert.deepEqual(main.review_queue, { pending_items: 1, pending_edges: 0, experience_awaiting_verdict: 0, pending_folds: 0 });
    const mainText = JSON.stringify(main);
    for (const marker of ['other-decision', 'other-skill', 'other-pending', 'other-kept-change', 'other-awaiting', 'task-other', 'Other room task', 'Already done', 'Canceled work']) {
      assert.equal(mainText.includes(marker), false, marker);
    }
    assert.deepEqual(ids(other.decisions), ['other-decision']);
    assert.deepEqual(ids(other.skills), ['other-skill']);
    assert.deepEqual(other.recent_kept_experience.map(entry => entry.change), ['other-kept-change']);
    assert.deepEqual(other.open_tasks, [{ id: 'task-other', goal: 'Other room task', state: 'in_progress', owner_id: 'agent:grok', holder_id: 'agent:dots' }]);
    assert.equal(other.review_queue.pending_items, 1);
    assert.equal(other.review_queue.experience_awaiting_verdict, 1);
    const otherText = JSON.stringify(other);
    for (const marker of ['main-decision', 'main-skill', 'main-pending', 'main-kept-change', 'task-open', 'Ship the brief']) {
      assert.equal(otherText.includes(marker), false, marker);
    }
  } finally { await close(); }
});

test('the brief stays within max_chars and sets truncated', async () => {
  const { db, close } = await start();
  try {
    await assert.rejects(() => roomBrief(db, ROOM, { maxChars: 999 }), refused);
    await assert.rejects(() => roomBrief(db, ROOM, { maxChars: 8001 }), refused);
    await assert.rejects(() => roomBrief(db, ROOM, { maxChars: 1000.5 }), refused);
    await assert.rejects(() => roomBrief(db, ROOM, { at: 'yesterday' }), refused);
    await say(db, 'm-src', 'proposal', T0);
    await say(db, 'm-out', 'outcome', T1);
    for (const n of [1, 2, 3, 4]) {
      const id = `dec-${n}`;
      const validFrom = `2026-10-0${n}T00:00:00.000Z`;
      await say(db, `msg-${id}`, `source ${id}`, validFrom);
      const title = (`D${n} ` + 'gateway '.repeat(24)).slice(0, 180);
      await keep(db, { id, title, body: `BODY_ONLY_${id} stays out of the brief.`, source_message_id: `msg-${id}`, valid_from: validFrom });
    }
    await say(db, 'msg-skill', 'skill source', T0);
    await keep(db, { id: 'skill-1', kind: 'skill', tier: 3, title: 'Brief skill', body: 'BODY_ONLY_skill stays out.', source_message_id: 'msg-skill', valid_from: T0 });
    await keepExperience(db, 'Keep the first memory note.');
    await keepExperience(db, 'Keep the second memory note.');
    await db.batch([
      db.prepare(`INSERT INTO tasks(id,room_id,creator_id,owner_id,spec_json,state,version,created_at_ms,updated_at_ms) VALUES ('task-new','room_main','agent:grok','agent:grok','{"goal":"Newer open task"}','in_progress',1,1,20)`),
      db.prepare(`INSERT INTO task_leases(task_id,holder_id,lease_epoch,expires_at_ms) VALUES ('task-new','agent:grok',1,9999999999999)`),
      db.prepare(`INSERT INTO tasks(id,room_id,creator_id,spec_json,state,version,created_at_ms,updated_at_ms) VALUES ('task-old','room_main','agent:grok','{"goal":"Older open task"}','open',1,1,10)`),
      db.prepare(`INSERT INTO task_leases(task_id,holder_id,lease_epoch,expires_at_ms) VALUES ('task-old','agent:dots',3,1)`),
      db.prepare(`INSERT INTO tasks(id,room_id,creator_id,spec_json,state,version,created_at_ms,updated_at_ms) VALUES ('task-done','room_main','agent:grok','{"goal":"Done task"}','done',1,1,30)`),
    ]);
    const wide = await roomBrief(db, ROOM, { at: AT, maxChars: 8000 });
    assert.equal(wide.truncated, false);
    assert.ok(JSON.stringify(wide).length <= 8000);
    assert.ok(JSON.stringify(wide).length > 1000);
    assert.deepEqual(ids(wide.decisions), ['dec-4', 'dec-3', 'dec-2', 'dec-1']);
    assert.deepEqual(ids(wide.skills), ['skill-1']);
    assert.equal(wide.skills[0]?.grade, 'F');
    assert.equal(wide.recent_kept_experience.length, 2);
    assert.deepEqual(ids(wide.open_tasks), ['task-new', 'task-old']);
    assert.equal(wide.open_tasks[0]?.state, 'in_progress');
    assert.equal(wide.open_tasks[0]?.holder_id, 'agent:grok');
    assert.equal(wide.open_tasks[1]?.owner_id, null);
    assert.equal(wide.open_tasks[1]?.holder_id, null);
    assert.equal(JSON.stringify(wide).includes('BODY_ONLY_'), false);
    assert.equal(JSON.stringify(wide).includes('Done task'), false);
    const same = await roomBrief(db, ROOM, { at: AT });
    assert.deepEqual(same, await roomBrief(db, ROOM, { at: AT, maxChars: 4000 }));
    assert.ok(JSON.stringify(same).length <= 4000);
    const tight = await roomBrief(db, ROOM, { at: AT, maxChars: 1000 });
    assert.equal(tight.truncated, true);
    assert.ok(JSON.stringify(tight).length <= 1000);
    assert.equal(tight.notes.some(note => note.includes('Dropped')), true);
    const order = ['recent_kept_experience', 'open_tasks', 'skills', 'decisions'] as const;
    let blocked = false;
    for (const key of order) {
      const short = tight[key];
      const full = wide[key];
      assert.deepEqual(ids(short), ids(full).slice(0, short.length), key);
      if (blocked) assert.equal(short.length, full.length, key);
      if (short.length < full.length && short.length > 0) blocked = true;
    }
    assert.ok(tight.decisions.length < wide.decisions.length || tight.skills.length < wide.skills.length || tight.open_tasks.length < wide.open_tasks.length || tight.recent_kept_experience.length < wide.recent_kept_experience.length);
  } finally { await close(); }
});

test('an unauthorized room is refused', async () => {
  const { db, close } = await start();
  try {
    await db.batch([
      db.prepare("INSERT INTO memberships(principal_id,room_id,active,can_post) VALUES ('agent:grok','room_main',1,0)"),
      db.prepare("INSERT INTO memberships(principal_id,room_id,active,can_post) VALUES ('agent:grok','room_other',1,1)"),
    ]);
    const tally = async () => db.prepare(`SELECT
      (SELECT count(*) FROM memory_items) AS items,
      (SELECT count(*) FROM memory_edges) AS edges,
      (SELECT count(*) FROM experience_entries) AS experience,
      (SELECT count(*) FROM tasks) AS tasks,
      (SELECT count(*) FROM memory_reviews) AS reviews`).first();
    const before = await tally();
    const member = new Workroom(db, 'agent:grok');
    const ok = await member.briefGet({ room: ROOM, at: '2026-10-23T09:00:00+09:00', max_chars: 4000 });
    assert.equal(ok.data.at, AT);
    assert.equal(ok.data.room, ROOM);
    assert.equal(ok.data.truncated, false);
    await assert.rejects(() => member.briefGet({ room: OTHER }), forbidden);
    await assert.rejects(() => new Workroom(db, 'agent:outsider').briefGet({ room: ROOM }), forbidden);
    assert.deepEqual(await tally(), before);
  } finally { await close(); }
});

test('decisions are bounded in SQL with explicit omission metadata (Codex d5c3553b)', async () => {
  const { db, close } = await start();
  try {
    const total = DECISION_LIMIT + 20;
    for (let n = 0; n < total; n++) {
      const validFrom = new Date(Date.parse(T0) + n * 60_000).toISOString();
      await say(db, `msg-b${n}`, `source ${n}`, validFrom);
      await keep(db, { id: `dec-b${String(n).padStart(3, '0')}`, title: `Decision ${n}`, source_message_id: `msg-b${n}`, valid_from: validFrom });
    }
    const pending = await proposeItem(db, 'agent:grok', input({ id: 'dec-pending', source_message_id: 'msg-b0', valid_from: T1 }));
    assert.equal(pending.review_state, 'pending');
    const wide = await roomBrief(db, ROOM, { at: AT, maxChars: 8000 });
    assert.equal(wide.decisions_omitted, 20);
    assert.ok(wide.notes.some(note => note.includes(`newest ${DECISION_LIMIT} of ${total}`)));
    assert.equal(wide.decisions[0]?.id, `dec-b${String(total - 1).padStart(3, '0')}`);
    assert.ok(wide.decisions.length <= DECISION_LIMIT);
    assert.equal(ids(wide.decisions).includes('dec-pending'), false);
    const tight = await roomBrief(db, ROOM, { at: AT, maxChars: 1000 });
    assert.equal(tight.truncated, true);
    assert.equal(tight.decisions_omitted, 20);
    assert.ok(tight.notes.some(note => note.includes('before budget trimming')));
    assert.ok(tight.decisions.length < DECISION_LIMIT);
    assert.ok(JSON.stringify(tight).length <= 1000);
    assert.deepEqual(ids(tight.decisions), ids(wide.decisions).slice(0, tight.decisions.length));
    const early = await roomBrief(db, ROOM, { at: new Date(Date.parse(T0) + 10 * 60_000).toISOString(), maxChars: 8000 });
    assert.equal(early.decisions_omitted, 0);
    assert.equal(early.decisions.length, 11); // valid_from <= at includes n = 0..10
  } finally { await close(); }
});
