import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { migrate } from '../scripts/local-harness.ts';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import { contextPack, type ContextPack, type PackEntry } from '../src/server/context-pack.ts';
import { Fault } from '../src/server/contracts.ts';
import type { Database } from '../src/server/db.ts';
import { proposeItem, proposeSupersede, type MemoryItem, type ProposeItemInput } from '../src/server/memory-items.ts';
import { edgeContentDigest, itemContentDigest, reviewEdge, reviewItem } from '../src/server/memory-review.ts';

// Each test owns a Miniflare D1, same start/migrate shape as tests/ocgw-review.test.ts, through migration 0014.
const ROOM = 'room_main';
const T0 = '2026-10-01T00:00:00.000Z';
const BETWEEN = '2026-10-10T00:00:00.000Z';
const T1 = '2026-10-20T00:00:00.000Z';
const AT = '2026-10-23T00:00:00.000Z';
const FUTURE = '2026-11-01T00:00:00.000Z';
const LATER = '2026-12-01T00:00:00.000Z';

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
    db.prepare("INSERT INTO memory_reviewers(principal_id, added_at) VALUES ('agent:dots', '2026-10-22T00:00:00.000Z')"),
  ]);
  return { db, close: () => mf.dispose().then(d1.cleanup) };
}

function input(over: Partial<ProposeItemInput> = {}): ProposeItemInput {
  return {
    room_id: ROOM, kind: 'fact', tier: 1, title: 'A fact', body: 'The room agreed on the record.',
    source_message_id: 'msg-1', valid_from: T0, ...over,
  };
}

async function say(db: Database, id: string, text: string, createdAt: string, room = ROOM): Promise<void> {
  await db.prepare('INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES (?,?,?,?,?,?)')
    .bind(id, room, 'agent:grok', text, 'text', createdAt).all();
}

async function revise(db: Database, messageId: string, revisionId: string, text: string, createdAt: string): Promise<void> {
  await db.prepare('INSERT INTO message_revisions(id,message_id,version,editor_id,text,format,created_at) VALUES (?,?,2,?,?,?,?)')
    .bind(revisionId, messageId, 'agent:grok', text, 'text', createdAt).all();
}

async function approve(db: Database, item: MemoryItem): Promise<void> {
  await reviewItem(db, 'agent:dots', item.id, 'approve', 'Recorded.', await itemContentDigest(item));
}

async function keep(db: Database, over: Partial<ProposeItemInput>): Promise<MemoryItem> {
  const item = await proposeItem(db, 'agent:grok', input(over));
  await approve(db, item);
  return item;
}

function expectPack(pack: ContextPack, budget: number): void {
  assert.deepEqual(Object.keys(pack.sections), ['decisions', 'skills', 'facts', 'messages']);
  assert.equal(pack.used_chars, JSON.stringify(pack.sections).length);
  assert.ok(pack.used_chars <= budget);
  assert.equal(typeof pack.truncated, 'boolean');
  const flat = [...pack.sections.decisions, ...pack.sections.skills, ...pack.sections.facts, ...pack.sections.messages];
  const seen = new Set<string>();
  const lineage: string[] = [];
  for (const entry of flat) {
    assert.equal(typeof entry.id, 'string');
    assert.ok(entry.id.length > 0);
    assert.equal(typeof entry.valid_from, 'string');
    assert.ok(entry.valid_from.length > 0);
    assert.equal(typeof entry.source_message_id, 'string');
    assert.ok(entry.source_message_id.length > 0);
    assert.equal(typeof entry.source_excerpt, 'string');
    assert.ok([...entry.source_excerpt].length <= 280);
    assert.ok((entry.title ?? entry.snippet ?? '').length > 0);
    if (seen.has(entry.source_message_id)) continue;
    seen.add(entry.source_message_id);
    lineage.push(entry.source_message_id);
  }
  assert.deepEqual(pack.lineage, lineage);
}

function ids(entries: PackEntry[]): string[] {
  return entries.map(entry => entry.id);
}

test('budgetChars outside 500..20000 is refused', async () => {
  const { db, close } = await start();
  try {
    const refused = (err: unknown) => err instanceof Fault && err.code === 'INVALID_INPUT';
    await assert.rejects(() => contextPack(db, ROOM, 'gateway', 499, AT), refused);
    await assert.rejects(() => contextPack(db, ROOM, 'gateway', 20001, AT), refused);
    await assert.rejects(() => contextPack(db, ROOM, 'gateway', 500.5, AT), refused);
    const empty = await contextPack(db, ROOM, 'gateway', 500, AT);
    expectPack(empty, 500);
    assert.equal(empty.truncated, false);
    assert.deepEqual(empty.sections, { decisions: [], skills: [], facts: [], messages: [] });
    const wide = await contextPack(db, ROOM, 'gateway', 20000, AT);
    assert.deepEqual(wide, empty);
  } finally { await close(); }
});

test('decisions and facts rank by term overlap then recency, and tier 3 skills come first', async () => {
  const { db, close } = await start();
  try {
    const rows: Array<{ id: string; kind: 'decision' | 'fact' | 'skill'; tier: number; title: string; body: string; valid_from: string }> = [
      { id: 'dec-high', kind: 'decision', tier: 2, title: 'Gateway deploy', body: 'Deploy the gateway now.', valid_from: BETWEEN },
      { id: 'dec-new', kind: 'decision', tier: 2, title: 'Gateway status', body: 'The gateway is open.', valid_from: T1 },
      { id: 'dec-old', kind: 'decision', tier: 2, title: 'Gateway note', body: 'The gateway is shut.', valid_from: T0 },
      { id: 'skill-tier3-both', kind: 'skill', tier: 3, title: 'Gateway deploy skill', body: 'Follow the checklist.', valid_from: T0 },
      { id: 'skill-tier3-one', kind: 'skill', tier: 3, title: 'Gateway skill', body: 'Copy the disk.', valid_from: T1 },
      { id: 'skill-tier1-both', kind: 'skill', tier: 1, title: 'Gateway deploy helper', body: 'Deploy the gateway carefully.', valid_from: T1 },
      { id: 'fact-high', kind: 'fact', tier: 1, title: 'Friday deploy', body: 'The gateway deploy is on Friday.', valid_from: BETWEEN },
      { id: 'fact-new', kind: 'fact', tier: 1, title: 'Gateway state', body: 'The gateway is up.', valid_from: T1 },
      { id: 'fact-old', kind: 'fact', tier: 1, title: 'Gateway age', body: 'The gateway is old.', valid_from: T0 },
    ];
    for (const row of rows) {
      const messageId = `msg-${row.id}`;
      await say(db, messageId, `source ${messageId}`, row.valid_from);
      await keep(db, { ...row, source_message_id: messageId });
    }
    const pack = await contextPack(db, ROOM, 'gateway deploy', 20000, AT);
    expectPack(pack, 20000);
    assert.equal(pack.truncated, false);
    assert.deepEqual(ids(pack.sections.decisions), ['dec-high', 'dec-new', 'dec-old']);
    assert.deepEqual(ids(pack.sections.skills), ['skill-tier3-both', 'skill-tier3-one', 'skill-tier1-both']);
    assert.deepEqual(ids(pack.sections.facts), ['fact-high', 'fact-new', 'fact-old']);
    assert.deepEqual(pack.sections.messages, []);
    const top = pack.sections.decisions[0];
    assert.ok(top);
    assert.equal(top.title, 'Gateway deploy');
    assert.equal(top.snippet, 'Deploy the gateway now.');
    assert.equal(top.valid_from, BETWEEN);
    assert.equal(top.source_message_id, 'msg-dec-high');
    assert.equal(top.source_excerpt, 'source msg-dec-high');
    assert.equal(Object.keys(top).join(','), 'id,title,snippet,valid_from,source_message_id,source_version,source_current_version,source_excerpt,source_version_basis');
    for (const entry of [...pack.sections.decisions, ...pack.sections.skills, ...pack.sections.facts]) {
      assert.equal(entry.source_excerpt, `source ${entry.source_message_id}`);
    }
  } finally { await close(); }
});

test('the pack stays inside the character budget and drops the lowest priority entries first', async () => {
  const { db, close } = await start();
  try {
    const highBody = `${'Approved detail. '.repeat(36)}Gateway deploy stands.`;
    const lowBody = 'Calendar note. '.repeat(40);
    await say(db, 'msg-dec-high', 'source dec-high', T0);
    await say(db, 'msg-dec-low', 'source dec-low', T0);
    await say(db, 'msg-dec-tiny', 'source dec-tiny', T0);
    await say(db, 'msg-hit', 'Remember the gateway deploy checklist', T1);
    await keep(db, { id: 'dec-high', kind: 'decision', tier: 2, title: 'Gateway deploy plan', body: highBody, source_message_id: 'msg-dec-high', valid_from: T0 });
    await keep(db, { id: 'dec-low', kind: 'decision', tier: 2, title: 'Lunch notes', body: lowBody, source_message_id: 'msg-dec-low', valid_from: T1 });
    await keep(db, { id: 'dec-tiny', kind: 'decision', tier: 2, title: 'Bring soup', body: 'Bring soup.', source_message_id: 'msg-dec-tiny', valid_from: T0 });
    const wide = await contextPack(db, ROOM, 'gateway deploy', 20000, AT);
    expectPack(wide, 20000);
    assert.equal(wide.truncated, false);
    assert.deepEqual(ids(wide.sections.decisions), ['dec-high', 'dec-low', 'dec-tiny']);
    assert.deepEqual(ids(wide.sections.messages), ['msg-hit']);
    const byId = new Map(wide.sections.decisions.map(entry => [entry.id, entry]));
    const dHigh = byId.get('dec-high');
    const dLow = byId.get('dec-low');
    const dTiny = byId.get('dec-tiny');
    const hit = wide.sections.messages[0];
    assert.ok(dHigh && dLow && dTiny && hit);
    const size = (decisions: PackEntry[], messages: PackEntry[]) => JSON.stringify({ decisions, skills: [], facts: [], messages }).length;
    const one = size([dHigh], []);
    const tinyOnly = size([dTiny], []);
    const withNext = size([dHigh, dLow], []);
    const withHit = size([dHigh], [hit]);
    assert.ok(one > 500, `top decision pack is ${one} chars`);
    assert.ok(tinyOnly <= 500, `tiny decision pack is ${tinyOnly} chars`);
    assert.ok(withNext > withHit && withHit >= 500 && withHit <= 20000);
    const tight = await contextPack(db, ROOM, 'gateway deploy', withHit, AT);
    expectPack(tight, withHit);
    assert.equal(tight.truncated, true);
    assert.deepEqual(ids(tight.sections.decisions), ['dec-high']);
    assert.deepEqual(tight.sections.skills, []);
    assert.deepEqual(tight.sections.facts, []);
    assert.deepEqual(tight.sections.messages, []);
    const dropped = await contextPack(db, ROOM, 'gateway deploy', 500, AT);
    expectPack(dropped, 500);
    assert.equal(dropped.truncated, true);
    assert.deepEqual(dropped.sections, { decisions: [], skills: [], facts: [], messages: [] });
    const exact = await contextPack(db, ROOM, 'gateway deploy', wide.used_chars, AT);
    assert.equal(exact.truncated, false);
    assert.deepEqual(exact.sections, wide.sections);
    assert.deepEqual(exact.lineage, wide.lineage);
  } finally { await close(); }
});

test('pending and rejected items are excluded', async () => {
  const { db, close } = await start();
  try {
    await say(db, 'msg-pending', 'plain note', T0);
    await say(db, 'msg-rejected', 'other note', T0);
    await say(db, 'msg-kept', 'kept note', T0);
    await say(db, 'msg-skill', 'skill note', T0);
    const pending = await proposeItem(db, 'agent:grok', input({
      id: 'pending-dec', kind: 'decision', tier: 2, title: 'Gateway deploy pending', body: 'Deploy the gateway later.',
      source_message_id: 'msg-pending', valid_from: T0,
    }));
    const rejected = await proposeItem(db, 'agent:grok', input({
      id: 'rejected-fact', kind: 'fact', tier: 1, title: 'Gateway deploy rejected', body: 'Deploy the gateway never.',
      source_message_id: 'msg-rejected', valid_from: T0,
    }));
    await reviewItem(db, 'agent:dots', rejected.id, 'reject', 'No.', await itemContentDigest(rejected));
    await proposeItem(db, 'agent:grok', input({
      id: 'pending-skill', kind: 'skill', tier: 3, title: 'Pending skill', body: 'Copy the disk.',
      source_message_id: 'msg-skill', valid_from: T0,
    }));
    const kept = await keep(db, {
      id: 'kept-fact', kind: 'fact', tier: 1, title: 'Gateway deploy kept', body: 'The gateway deploy happened.',
      source_message_id: 'msg-kept', valid_from: T0,
    });
    const pack = await contextPack(db, ROOM, 'gateway deploy', 20000, AT);
    expectPack(pack, 20000);
    assert.deepEqual(ids(pack.sections.decisions), []);
    assert.deepEqual(ids(pack.sections.skills), []);
    assert.deepEqual(ids(pack.sections.facts), [kept.id]);
    assert.deepEqual(pack.sections.messages, []);
    assert.equal(pending.review_state, 'pending');
    const again = await contextPack(db, ROOM, 'gateway deploy', 20000);
    assert.deepEqual(ids(again.sections.facts), [kept.id]);
    assert.deepEqual(ids(again.sections.decisions), []);
  } finally { await close(); }
});

test('a superseded decision is absent at now and present at an earlier at', async () => {
  const { db, close } = await start();
  try {
    await say(db, 'msg-old', 'old decision source', T0);
    await say(db, 'msg-new', 'new decision source', T0);
    await say(db, 'msg-now', 'A decision record posted now', AT);
    await say(db, 'msg-future', 'A decision record from the future', FUTURE);
    const older = await keep(db, {
      id: 'dec-old', kind: 'decision', tier: 2, title: 'Decision record old', body: 'Use the old record.',
      source_message_id: 'msg-old', valid_from: T0,
    });
    const newer = await keep(db, {
      id: 'dec-new', kind: 'decision', tier: 2, title: 'Decision record new', body: 'Use the new record.',
      source_message_id: 'msg-new', valid_from: T1,
    });
    const open = await contextPack(db, ROOM, 'decision record', 20000, AT);
    assert.deepEqual(ids(open.sections.decisions), [newer.id, older.id]);
    const edge = await proposeSupersede(db, 'agent:grok', older.id, newer.id);
    const stillOpen = await contextPack(db, ROOM, 'decision record', 20000, AT);
    assert.deepEqual(ids(stillOpen.sections.decisions), [newer.id, older.id]);
    await reviewEdge(db, 'agent:dots', edge.id, 'approve', 'The new decision replaces it.', await edgeContentDigest(edge));
    const after = await contextPack(db, ROOM, 'decision record', 20000, AT);
    expectPack(after, 20000);
    assert.deepEqual(ids(after.sections.decisions), [newer.id]);
    assert.ok(ids(after.sections.messages).includes('msg-now'));
    assert.ok(!ids(after.sections.messages).includes('msg-future'));
    const earlier = await contextPack(db, ROOM, 'decision record', 20000, BETWEEN);
    expectPack(earlier, 20000);
    assert.deepEqual(ids(earlier.sections.decisions), [older.id]);
    assert.equal(earlier.sections.decisions[0]?.valid_from, T0);
    assert.equal(earlier.sections.decisions[0]?.source_message_id, 'msg-old');
    assert.equal(earlier.sections.decisions[0]?.source_excerpt, 'old decision source');
    assert.ok(!ids(earlier.sections.messages).includes('msg-now'));
    assert.ok(!ids(earlier.sections.messages).includes('msg-future'));
    const later = await contextPack(db, ROOM, 'decision record', 20000, LATER);
    assert.deepEqual(ids(later.sections.decisions), [newer.id]);
    assert.ok(ids(later.sections.messages).includes('msg-future'));
    assert.ok(ids(later.sections.messages).includes('msg-now'));
    const omitted = await contextPack(db, ROOM, 'decision record', 20000);
    assert.deepEqual(ids(omitted.sections.decisions), [newer.id]);
    assert.ok(!ids(omitted.sections.decisions).includes(older.id));
  } finally { await close(); }
});

test('each entry carries valid_from, source_message_id, and a source excerpt of at most 280 chars', async () => {
  const { db, close } = await start();
  try {
    await say(db, 'msg-long', 'short original', T0);
    await say(db, 'msg-short', 'original note', T0);
    const revisedLong = `${'X'.repeat(320)} gateway deploy ending`;
    await revise(db, 'msg-long', 'rev-long', revisedLong, T1);
    await revise(db, 'msg-short', 'rev-short', 'Revised gateway deploy note', T1);
    const longItem = await keep(db, {
      id: 'dec-long', kind: 'decision', tier: 2, title: 'Gateway deploy long', body: 'Ship the gateway deploy.',
      source_message_id: 'msg-long', valid_from: T0,
    });
    const shortItem = await keep(db, {
      id: 'fact-short', kind: 'fact', tier: 1, title: 'Gateway deploy short', body: 'The note changed.',
      source_message_id: 'msg-short', valid_from: T0,
    });
    const pack = await contextPack(db, ROOM, 'gateway deploy', 20000, AT);
    expectPack(pack, 20000);
    const longEntry = pack.sections.decisions.find(entry => entry.id === longItem.id);
    const shortEntry = pack.sections.facts.find(entry => entry.id === shortItem.id);
    assert.ok(longEntry && shortEntry);
    assert.equal(longEntry.valid_from, T0);
    assert.equal(longEntry.source_message_id, 'msg-long');
    assert.equal(longEntry.source_excerpt, 'X'.repeat(280));
    assert.equal([...longEntry.source_excerpt].length, 280);
    assert.notEqual(longEntry.source_excerpt, 'short original');
    assert.notEqual(longEntry.source_excerpt, longEntry.snippet);
    assert.equal(shortEntry.source_excerpt, 'Revised gateway deploy note');
    assert.notEqual(shortEntry.source_excerpt, 'original note');
    assert.equal(shortEntry.source_message_id, 'msg-short');
    assert.equal(shortEntry.valid_from, T0);
    assert.ok(!ids(pack.sections.messages).includes('msg-long'));
    assert.ok(!ids(pack.sections.messages).includes('msg-short'));
  } finally { await close(); }
});

test('the same input returns the same pack', async () => {
  const { db, close } = await start();
  try {
    await say(db, 'msg-a', 'alpha gateway deploy', T0);
    await revise(db, 'msg-a', 'rev-a', 'alpha gateway deploy revised', T1);
    await say(db, 'msg-b', 'beta checklist', T0);
    await say(db, 'msg-c', 'extra gateway deploy hit', BETWEEN);
    await keep(db, { id: 'dec-a', kind: 'decision', tier: 2, title: 'Gateway deploy', body: 'Ship the gateway.', source_message_id: 'msg-a', valid_from: T0 });
    await keep(db, { id: 'skill-b', kind: 'skill', tier: 3, title: 'Restore disk', body: 'Copy the disk.', source_message_id: 'msg-b', valid_from: T0 });
    await keep(db, { id: 'fact-a', kind: 'fact', tier: 1, title: 'Gateway state', body: 'The gateway deploy finished.', source_message_id: 'msg-a', valid_from: T1 });
    const first = await contextPack(db, ROOM, 'gateway deploy', 20000, AT);
    const second = await contextPack(db, ROOM, 'gateway deploy', 20000, AT);
    expectPack(first, 20000);
    assert.deepEqual(second, first);
    assert.equal(JSON.stringify(second), JSON.stringify(first));
    assert.deepEqual(ids(first.sections.decisions), ['dec-a']);
    assert.deepEqual(ids(first.sections.skills), ['skill-b']);
    assert.deepEqual(ids(first.sections.facts), ['fact-a']);
    assert.deepEqual(ids(first.sections.messages), ['msg-c']);
    assert.equal(first.sections.decisions[0]?.source_excerpt, 'alpha gateway deploy revised');
    assert.deepEqual(first.lineage, ['msg-a', 'msg-b', 'msg-c']);
    assert.equal(first.truncated, false);
  } finally { await close(); }
});

test('search hits that are already item sources are not repeated as messages', async () => {
  const { db, close } = await start();
  try {
    await say(db, 'msg-src', 'The gateway deploy window is Friday', T0);
    await revise(db, 'msg-src', 'rev-src', 'The gateway deploy window is Monday', T1);
    await say(db, 'msg-other', 'Remember the gateway deploy checklist', BETWEEN);
    await say(db, 'msg-foreign', 'Remember the gateway deploy checklist', BETWEEN, 'room_other');
    const decision = await keep(db, {
      id: 'dec-src', kind: 'decision', tier: 2, title: 'Gateway deploy', body: 'Ship on the decided day.',
      source_message_id: 'msg-src', valid_from: T0,
    });
    const pack = await contextPack(db, ROOM, 'gateway deploy', 20000, AT);
    expectPack(pack, 20000);
    assert.equal(pack.truncated, false);
    assert.deepEqual(ids(pack.sections.decisions), [decision.id]);
    assert.deepEqual(ids(pack.sections.messages), ['msg-other']);
    const packed = pack.sections.decisions[0];
    const hit = pack.sections.messages[0];
    assert.ok(packed && hit);
    assert.equal(packed.valid_from, T0);
    assert.equal(packed.source_message_id, 'msg-src');
    assert.equal(packed.source_excerpt, 'The gateway deploy window is Monday');
    assert.equal(hit.id, 'msg-other');
    assert.equal(hit.source_message_id, 'msg-other');
    assert.equal(hit.valid_from, BETWEEN);
    assert.equal(hit.source_excerpt, 'Remember the gateway deploy checklist');
    assert.ok(typeof hit.snippet === 'string' && hit.snippet.length > 0);
    assert.equal(Object.keys(hit).join(','), 'id,snippet,valid_from,source_message_id,source_version,source_current_version,source_excerpt,source_version_basis');
    assert.deepEqual(pack.lineage, ['msg-src', 'msg-other']);
    assert.ok(!ids(pack.sections.messages).includes('msg-src'));
    assert.ok(!ids(pack.sections.messages).includes('msg-foreign'));
  } finally { await close(); }
});
