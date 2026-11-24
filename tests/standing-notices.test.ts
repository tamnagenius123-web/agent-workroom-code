import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { migrate } from '../scripts/local-harness.ts';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import { Fault } from '../src/server/contracts.ts';
import type { Database } from '../src/server/db.ts';
import { Workroom } from '../src/server/domain.ts';
import { fitContextData, type ContextSections, type PackEntry } from '../src/server/context-pack.ts';
import type { FoldContextSections } from '../src/server/fold-pack.ts';
import {
  PINNED_LIMIT, assertStandingFits, buildOwnerMemory, standingChars,
  type HookKind, type OwnerMemory,
} from '../src/server/memory-hook.ts';
import { fitBrief, roomBrief, type BriefDraft } from '../src/server/room-brief.ts';
import { pinTable } from '../src/server/pin-table.ts';
import type { OwnerDecision } from '../src/server/owner-decisions.ts';
import { proposeItem, proposeSupersede, type MemoryItem, type ProposeItemInput } from '../src/server/memory-items.ts';
import { edgeContentDigest, itemContentDigest, reviewEdge, reviewItem } from '../src/server/memory-review.ts';
import { STANDING_MEMORY_POLICY } from '../src/server/standing-memory.ts';

// U7/G4: standing owner notices (MEM-HOOK pinned core) and the pin comparison table.
// Owner-decision data remains the pure buildOwnerMemory seam (the private boundary
// stays closed). Reviewed standing-memory tests use real local D1 proposal/review.

const ROOM = 'room_main';
const AT = '2026-10-23T00:00:00.000Z';

function decision(over: Partial<OwnerDecision> = {}): OwnerDecision {
  return {
    id: 'od-1', ts_kst: '2026-11-01T09:00:00.000+09:00', source: 'telegram',
    verbatim: '그대로의 문장', normalized: 'Push stays approved for muse',
    topics: ['push'], supersedes: [], direct: true, active: true, ...over,
  };
}

const FIXTURE: OwnerDecision[] = [
  decision(),
  decision({ id: 'od-2', ts_kst: '2026-11-02T09:00:00.000+09:00', normalized: 'Merge gate is room PASS plus green CI', topics: ['merge'] }),
  // Superseded: replaced by od-2, so inactive. Its text matches the query best; it must still never appear.
  decision({ id: 'od-3', ts_kst: '2026-11-03T09:00:00.000+09:00', normalized: 'Merge gate is a GitHub APPROVED review', topics: ['merge'], active: false }),
  // Relayed (not direct): recall may surface it, the pinned core must not.
  decision({ id: 'od-4', ts_kst: '2026-11-04T09:00:00.000+09:00', normalized: 'Relayed note about the merge process', topics: ['merge'], direct: false }),
];

test('no decision data means no standing block', () => {
  assert.equal(buildOwnerMemory(null, { kind: 'handoff', text: 'merge gate' }), null);
});

test('pinned core holds only active direct decisions, oldest first; superseded never appears', () => {
  const om = buildOwnerMemory(FIXTURE, { kind: 'handoff', text: 'merge gate' });
  assert.ok(om);
  assert.deepEqual(om.pinned.map(p => p.id), ['od-1', 'od-2']);
  assert.equal(om.recalled.some(r => r.id === 'od-3'), false);
  assert.equal(om.pinned.some(p => p.id === 'od-3' || p.id === 'od-4'), false);
  assert.equal(om.recalled.some(r => r.id === 'od-4'), true);
});

test('the standing block is byte-stable across source row order', () => {
  const a = buildOwnerMemory(FIXTURE, { kind: 'decision', text: 'merge gate' });
  const b = buildOwnerMemory([...FIXTURE].reverse(), { kind: 'decision', text: 'merge gate' });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('every hook kind carries the pinned core first, even when recall is skipped as trivial', () => {
  for (const kind of ['handoff', 'question', 'decision'] as HookKind[]) {
    const om = buildOwnerMemory(FIXTURE, { kind, text: '네' });
    assert.ok(om);
    assert.equal(om.kind, kind);
    assert.equal(om.recall_skipped, 'trivial');
    assert.deepEqual(om.pinned.map(p => p.id), ['od-1', 'od-2']);
  }
});

test('pinned core is capped at PINNED_LIMIT newest direct decisions', () => {
  const many = Array.from({ length: PINNED_LIMIT + 2 }, (_, i) => decision({
    id: `od-n${i}`, ts_kst: `2026-11-${String(i + 1).padStart(2, '0')}T09:00:00.000+09:00`,
  }));
  const om = buildOwnerMemory(many, { kind: 'handoff', text: 'push' });
  assert.ok(om);
  assert.equal(om.pinned.length, PINNED_LIMIT);
  assert.equal(om.pinned[0]?.id, 'od-n2');
  assert.equal(om.pinned.at(-1)?.id, `od-n${PINNED_LIMIT + 1}`);
});

test('assertStandingFits fails instead of truncating an over-budget standing block', () => {
  const big: OwnerMemory = {
    kind: 'handoff',
    pinned: [{ id: 'od-x', source: 'telegram', ts_kst: '2026-11-01T09:00:00.000+09:00', normalized: 'x'.repeat(400) }],
    recalled: [], query_terms: [], recall_skipped: null, note: 'n',
  };
  assert.throws(
    () => assertStandingFits(big, 500, 'budget_chars'),
    (err: unknown) => err instanceof Fault && err.code === 'INVALID_INPUT' && /never truncated/.test(err.message),
  );
  assertStandingFits(big, 20000, 'budget_chars');
  assertStandingFits(null, 500, 'budget_chars');
});

test('per-entry text is capped at build time; the assembled block is then delivered whole or not at all', () => {
  const pinnedOm = buildOwnerMemory([decision({ normalized: 'n'.repeat(500) })], { kind: 'handoff', text: 'push' });
  assert.ok(pinnedOm);
  // Build-stage cap: the pinned entry carries normalized text clipped to 160 chars + ellipsis.
  assert.equal(pinnedOm.pinned[0]?.normalized, 'n'.repeat(160) + '…');
  const recalledOm = buildOwnerMemory(
    [decision({ id: 'od-r', direct: false, topics: ['cap'], normalized: 'cap ' + 'n'.repeat(500), verbatim: 'v'.repeat(800) })],
    { kind: 'handoff', text: 'cap' },
  );
  assert.ok(recalledOm);
  // Build-stage cap: the recalled entry carries verbatim text clipped to 300 chars + ellipsis.
  assert.equal(recalledOm.recalled[0]?.verbatim, 'v'.repeat(300) + '…');
  // After assembly there is no further clipping: a budget of exactly the block size passes
  // and leaves the block byte-identical; one char less fails instead of truncating it.
  const size = standingChars(pinnedOm);
  const before = JSON.stringify(pinnedOm);
  assertStandingFits(pinnedOm, size, 'budget_chars');
  assert.equal(JSON.stringify(pinnedOm), before);
  assert.throws(() => assertStandingFits(pinnedOm, size - 1, 'budget_chars'), /never truncated after assembly/);
});

function briefDraft(over: Partial<BriefDraft> = {}): BriefDraft {
  return {
    at: AT, room: ROOM, decisions: [], skills: [],
    review_queue: { pending_items: 0, pending_edges: 0, experience_awaiting_verdict: 0, pending_folds: 0 },
    recent_kept_experience: [], open_tasks: [], maxChars: 4000,
    ownerMemory: null, decisionsOmitted: 0, extraNotes: [], ...over,
  };
}

test('fitBrief fails when mandatory fields plus the standing block exceed max_chars, even if the block alone fits', () => {
  const om = buildOwnerMemory(FIXTURE, { kind: 'handoff', text: 'merge gate' });
  assert.ok(om);
  // The block alone fits this budget exactly (assertStandingFits passes), but the brief's
  // mandatory remainder (notes, review_queue, at/room) pushes the whole response over it:
  // the call must fail, not succeed with an over-budget brief (dots P2).
  assertStandingFits(om, standingChars(om), 'max_chars');
  assert.throws(
    () => fitBrief(briefDraft({ ownerMemory: om, maxChars: standingChars(om) })),
    (err: unknown) => err instanceof Fault && err.code === 'INVALID_INPUT' && /mandatory content/.test(err.message),
  );
  // The bare mandatory skeleton is also never returned over budget.
  assert.throws(() => fitBrief(briefDraft({ maxChars: 200 })), /mandatory content/);
});

test('fitBrief drops tail lists to fit but keeps the standing block byte-identical', () => {
  const om = buildOwnerMemory(FIXTURE, { kind: 'handoff', text: 'merge gate' });
  assert.ok(om);
  const decisions = Array.from({ length: 6 }, (_, i) => ({
    id: `dec-${i}`, title: 'T'.repeat(150), valid_from: '2026-10-01T00:00:00.000Z', valid_until: null,
    source_message_id: `m-${i}`, source_version: 1, source_version_basis: 'pinned' as const,
  }));
  const wide = fitBrief(briefDraft({ ownerMemory: om, decisions: [...decisions], maxChars: 8000 }));
  assert.equal(wide.truncated, false);
  assert.deepEqual(wide.owner_memory, om);
  const tight = fitBrief(briefDraft({ ownerMemory: om, decisions: [...decisions], maxChars: standingChars(om) + 1000 }));
  assert.equal(tight.truncated, true);
  assert.ok(JSON.stringify(tight).length <= standingChars(om) + 1000);
  assert.ok(tight.decisions.length < decisions.length);
  assert.equal(JSON.stringify(tight.owner_memory), JSON.stringify(om));
});

function entry(over: Partial<PackEntry> = {}): PackEntry {
  return {
    id: 'e-1', valid_from: '2026-10-01T00:00:00.000Z', source_message_id: 'm-1',
    source_version: 2, source_current_version: 2, source_excerpt: 'text',
    source_version_basis: 'pinned', ...over,
  };
}

test('pin table compares each entry pin with the current revision, in section order', () => {
  const sections: ContextSections = {
    decisions: [entry()],
    skills: [entry({ id: 'e-2', source_message_id: 'm-2', source_version: 1, source_current_version: 3 })],
    facts: [entry({ id: 'e-3', source_message_id: 'm-3', source_version: 1, source_current_version: 1, source_version_basis: 'inferred' })],
    messages: [entry({ id: 'm-4', source_message_id: 'm-4', source_version: 5, source_current_version: 5, source_version_basis: 'current' })],
  };
  assert.deepEqual(pinTable(sections), [
    { section: 'decisions', entry_id: 'e-1', source_message_id: 'm-1', source_version: 2, source_current_version: 2, basis: 'pinned', status: 'current' },
    { section: 'skills', entry_id: 'e-2', source_message_id: 'm-2', source_version: 1, source_current_version: 3, basis: 'pinned', status: 'stale' },
    { section: 'facts', entry_id: 'e-3', source_message_id: 'm-3', source_version: 1, source_current_version: 1, basis: 'inferred', status: 'inferred' },
    { section: 'messages', entry_id: 'm-4', source_message_id: 'm-4', source_version: 5, source_current_version: 5, basis: 'current', status: 'current' },
  ]);
});

test('pin table expands fold pins per source; a stale fold source has no carried current version', () => {
  const sections: FoldContextSections = {
    decisions: [], skills: [], facts: [],
    folds: [{
      fold_id: 'fold-1', snippet: 'summary', valid_from: '2026-10-01T00:00:00.000Z',
      span_from: '2026-10-01T00:00:00.000Z', span_to: '2026-10-02T00:00:00.000Z',
      source_message_ids: ['m-1', 'm-2'], source_hashes: ['h-1', 'h-2'], source_versions: [2, 1],
      stale_message_ids: ['m-2'], source_message_id: 'm-1', source_version_basis: 'pinned',
    }],
    messages: [],
  };
  assert.deepEqual(pinTable(sections), [
    { section: 'folds', entry_id: 'fold-1', source_message_id: 'm-1', source_version: 2, source_current_version: 2, basis: 'pinned', status: 'current' },
    { section: 'folds', entry_id: 'fold-1', source_message_id: 'm-2', source_version: 1, source_current_version: null, basis: 'pinned', status: 'stale' },
  ]);
});

async function start(): Promise<{ db: Database; close: () => Promise<void> }> {
  const d1 = await cloneD1(25);
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
    await migrate(db, 25);
    await db.batch([
      db.prepare("INSERT INTO rooms(id) VALUES ('room_main')"),
      db.prepare("INSERT INTO principals(id) VALUES ('agent:grok')"),
      db.prepare("INSERT INTO principals(id) VALUES ('agent:dots')"),
      db.prepare("INSERT INTO memory_reviewers(principal_id, added_at) VALUES ('agent:dots', '2026-10-22T00:00:00.000Z')"),
      db.prepare("INSERT INTO memberships(principal_id, room_id, active, can_post) VALUES ('agent:grok', 'room_main', 1, 1)"),
    ]);
    return { db, close: () => mf.dispose().then(d1.cleanup) };
  } catch (err) { await mf.dispose(); d1.cleanup(); throw err; }
}

test('domain context pack carries pin_table; owner_memory stays absent while the boundary source is unapplied', async () => {
  const { db, close } = await start();
  try {
    await db.prepare('INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES (?,?,?,?,?,?)')
      .bind('msg-1', ROOM, 'agent:grok', 'The room agreed on the record.', 'text', '2026-10-01T00:00:00.000Z').all();
    const item: MemoryItem = await proposeItem(db, 'agent:grok', {
      room_id: ROOM, kind: 'decision', tier: 1, title: 'A decision', body: 'The room agreed on the record.',
      source_message_id: 'msg-1', valid_from: '2026-10-01T00:00:00.000Z',
    });
    await reviewItem(db, 'agent:dots', item.id, 'approve', 'Recorded.', await itemContentDigest(item));
    const wr = new Workroom(db, 'agent:grok');
    const res = await wr.contextPack({ room: ROOM, task: 'record', budget_chars: 6000, at: AT });
    assert.equal('owner_memory' in res.data, false);
    assert.deepEqual(Object.keys(res.data), ['sections', 'used_chars', 'truncated', 'lineage', 'pin_table', 'manifest']);
    assert.deepEqual(res.data.pin_table, [
      { section: 'decisions', entry_id: item.id, source_message_id: 'msg-1', source_version: 1, source_current_version: 1, basis: 'pinned', status: 'current',
        source_sha256: createHash('sha256').update('The room agreed on the record.').digest('hex'), source_present: true },
    ]);
    const folded = await wr.contextPack({ room: ROOM, task: 'record', budget_chars: 6000, at: AT, folds: true });
    assert.deepEqual(folded.data.pin_table, res.data.pin_table);
  } finally { await close(); }
});

async function standingItem(db: Database, over: Partial<ProposeItemInput> & { id: string }, approve = true): Promise<MemoryItem> {
  const source = over.source_message_id ?? `source-${over.id}`;
  const room = over.room_id ?? ROOM;
  await db.prepare('INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES (?,?,?,?,?,?)')
    .bind(source, room, 'agent:grok', `Evidence for ${over.id}: 안녕하세요 😀`, 'text', '2026-10-01T00:00:00.000Z').all();
  const item = await proposeItem(db, 'agent:grok', {
    room_id: room, kind: 'decision', tier: 2, title: `[standing] ${over.id}`, body: `Approved notice ${over.id}.`,
    source_message_id: source, valid_from: '2026-10-01T00:00:00.000Z', ...over,
  });
  if (approve) await reviewItem(db, 'agent:dots', item.id, 'approve', 'Recorded.', await itemContentDigest(item));
  return item;
}

test('nine approved opt-in notices appear in a stable full prefix in plain pack, folded pack and brief', async () => {
  const { db, close } = await start();
  try {
    for (const id of ['dec-d', 'dec-b', 'dec-a', 'dec-c']) await standingItem(db, { id });
    for (const id of ['fact-b', 'fact-a']) await standingItem(db, { id, kind: 'fact' });
    for (const id of ['skill-c', 'skill-a', 'skill-b']) await standingItem(db, { id, kind: 'skill', tier: 3 });
    await standingItem(db, { id: 'pending' }, false);
    await standingItem(db, { id: 'ordinary', title: 'Certified but not a standing notice' });
    await standingItem(db, { id: 'low-tier', tier: 1 });
    await db.prepare("INSERT INTO rooms(id) VALUES ('room_other')").all();
    await standingItem(db, { id: 'foreign', room_id: 'room_other' });
    const wr = new Workroom(db, 'agent:grok');
    const a = await wr.contextPack({ room: ROOM, task: 'unrelated first task', budget_chars: 20000, at: AT });
    const b = await wr.contextPack({ room: ROOM, task: 'different next task', budget_chars: 20000, at: '2026-10-24T00:00:00.000Z', folds: true });
    const brief = await wr.briefGet({ room: ROOM, max_chars: 8000, at: AT, task: 'third task' });
    const expected = ['dec-a', 'dec-b', 'dec-c', 'dec-d', 'fact-a', 'fact-b', 'skill-a', 'skill-b', 'skill-c'];
    assert.deepEqual(a.data.standing_memory?.notices.map(notice => notice.id), expected);
    assert.equal(a.data.standing_memory?.policy, STANDING_MEMORY_POLICY);
    assert.equal(JSON.stringify(a.data.standing_memory), JSON.stringify(b.data.standing_memory));
    assert.equal(JSON.stringify(a.data.standing_memory), JSON.stringify(brief.data.standing_memory));
    for (const data of [a.data, b.data, brief.data]) assert.equal(Object.keys(data)[0], 'standing_memory');
    const prefix = JSON.stringify(a.data.standing_memory);
    for (const forbidden of ['pending', 'ordinary', 'low-tier', 'foreign', 'created_at', 'valid_from', 'heartbeat', 'query_terms']) {
      assert.equal(prefix.includes(forbidden), false, forbidden);
    }
    assert.equal('owner_memory' in a.data, false, 'approved room memory is not invented private owner authority');
    assert.equal(a.data.pin_table.filter(pin => pin.section === 'standing').length, 9);
    assert.equal(a.data.manifest.token_count, null);
    assert.equal(a.data.manifest.token_status, 'unknown');
  } finally { await close(); }
});

test('standing source pins bind raw revisions while emitted digest and UTF-16 size bind the whole response', async () => {
  const { db, close } = await start();
  try {
    const notice = await standingItem(db, { id: 'notice-source', body: 'Full approved body 😀'.repeat(8) });
    const wr = new Workroom(db, 'agent:grok');
    await wr.g2.revise({ schema_version: '1', room: ROOM, message_id: notice.source_message_id, expected_version: 1,
      text: 'A later source revision', format: 'text', idempotency_key: 'notice-source-revision-2' });
    const { data } = await wr.contextPack({ room: ROOM, task: 'notice', budget_chars: 6000, at: AT });
    assert.equal(data.used_chars, JSON.stringify(data).length);
    const { used_chars: _used, manifest, ...payload } = data;
    void _used;
    assert.equal(manifest.payload_sha256, createHash('sha256').update(JSON.stringify(payload)).digest('hex'));
    assert.equal(manifest.payload_utf8_bytes, Buffer.byteLength(JSON.stringify(payload), 'utf8'));
    assert.equal(manifest.count_unit, 'utf16_code_units');
    const pin = data.pin_table.find(row => row.section === 'standing');
    assert.equal(pin?.source_version, 1);
    assert.equal(pin?.source_current_version, 2);
    assert.equal(pin?.status, 'stale');
    assert.equal(pin?.source_sha256, createHash('sha256').update('Evidence for notice-source: 안녕하세요 😀').digest('hex'));
    assert.equal(pin?.source_present, true);
    assert.equal(data.standing_memory?.notices[0]?.body, notice.body);
  } finally { await close(); }
});

test('mandatory reviewed notices never become partial output when pack or brief budget is too small', async () => {
  const { db, close } = await start();
  try {
    await standingItem(db, { id: 'large-notice', body: 'x'.repeat(1200) });
    const wr = new Workroom(db, 'agent:grok');
    const overflow = (error: unknown) => error instanceof Fault && error.code === 'MANDATORY_EXCEEDS_BUDGET';
    for (const folds of [false, true]) {
      await assert.rejects(() => wr.contextPack({ room: ROOM, task: 'anything', budget_chars: 500, at: AT, folds }), overflow);
    }
    await assert.rejects(() => roomBrief(db, ROOM, { maxChars: 1000, at: AT }), overflow);
    const fit = await wr.contextPack({ room: ROOM, task: 'anything', budget_chars: 6000, at: AT });
    assert.equal(fit.data.standing_memory?.notices[0]?.body.length, 1200);
  } finally { await close(); }
});

test('approved supersession removes the old notice and preserves the prefix before its position', async () => {
  const { db, close } = await start();
  try {
    await standingItem(db, { id: 'dec-a' });
    await standingItem(db, { id: 'dec-b' });
    const old = await standingItem(db, { id: 'dec-c' });
    const wr = new Workroom(db, 'agent:grok');
    const before = await wr.contextPack({ room: ROOM, task: 'before', budget_chars: 8000, at: AT });
    const replacement = await standingItem(db, { id: 'dec-d', valid_from: '2026-10-20T00:00:00.000Z' });
    const edge = await proposeSupersede(db, 'agent:grok', old.id, replacement.id);
    await reviewEdge(db, 'agent:dots', edge.id, 'approve', 'Superseded.', await edgeContentDigest(edge));
    const after = await wr.contextPack({ room: ROOM, task: 'after', budget_chars: 8000, at: AT });
    assert.deepEqual(after.data.standing_memory?.notices.map(notice => notice.id), ['dec-a', 'dec-b', 'dec-d']);
    const a = JSON.stringify(before.data.standing_memory);
    const b = JSON.stringify(after.data.standing_memory);
    assert.equal(a.slice(0, a.indexOf('"id":"dec-c"')), b.slice(0, b.indexOf('"id":"dec-d"')));
    assert.equal(b.includes('Approved notice dec-c.'), false);
  } finally { await close(); }
});

test('owner_memory and mandatory metadata are counted together at the final pack boundary', async () => {
  const { db, close } = await start();
  try {
    const owner = buildOwnerMemory(FIXTURE, { kind: 'handoff', text: 'merge gate' });
    assert.ok(owner);
    const pack = { sections: { decisions: [], skills: [], facts: [], messages: [] }, used_chars: 0, truncated: false, lineage: [] };
    const budget = Math.max(500, standingChars(owner));
    assertStandingFits(owner, budget, 'budget_chars');
    await assert.rejects(() => fitContextData(db, ROOM, pack, budget, owner, null),
      (error: unknown) => error instanceof Fault && error.code === 'MANDATORY_EXCEEDS_BUDGET');
    const data = await fitContextData(db, ROOM, pack, 4000, owner, null);
    assert.deepEqual(data.owner_memory, owner);
    assert.equal(data.used_chars, JSON.stringify(data).length);
  } finally { await close(); }
});

test('queue pickup and every explicit recall kind carry the same reviewed standing prefix', async () => {
  const { db, close } = await start();
  try {
    await migrate(db, 35);
    await standingItem(db, { id: 'wake-notice' });
    const wr = new Workroom(db, 'agent:grok');
    const reference = await wr.contextPack({ room: ROOM, task: 'wake', budget_chars: 6000 });
    const prefix = JSON.stringify(reference.data.standing_memory);
    for (const kind of ['handoff', 'question', 'decision'] as const) {
      const recall = await wr.memoryRecall({ room: ROOM, kind, text: '네' });
      assert.equal(JSON.stringify(recall.data.standing_memory), prefix);
      assert.equal(Object.keys(recall.data)[0], 'standing_memory');
      assert.equal(recall.data.owner_memory, null);
    }
    const queue = await wr.myQueue({ room: ROOM });
    assert.equal(JSON.stringify(queue.data.standing_memory), prefix);
    assert.equal(Object.keys(queue.data)[0], 'standing_memory');
    const outsider = new Workroom(db, 'agent:outsider');
    const forbidden = (error: unknown) => error instanceof Fault && error.code === 'FORBIDDEN';
    await assert.rejects(() => outsider.memoryRecall({ room: ROOM, kind: 'handoff', text: 'wake' }), forbidden);
    await assert.rejects(() => outsider.myQueue({ room: ROOM }), forbidden);
    await assert.rejects(() => outsider.contextPack({ room: ROOM, task: 'wake', budget_chars: 6000 }), forbidden);
  } finally { await close(); }
});

test('the final context data budget includes pin_table and response metadata for plain and folded packs', async () => {
  const { db, close } = await start();
  try {
    await db.prepare('INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES (?,?,?,?,?,?)')
      .bind('msg-budget', ROOM, 'agent:grok', 'Context budgeting evidence. ' + '😀'.repeat(180), 'text', '2026-10-01T00:00:00.000Z').all();
    const item = await proposeItem(db, 'agent:grok', {
      room_id: ROOM, kind: 'decision', tier: 1, title: 'Budget evidence', body: 'Context budgeting evidence. ' + '😀'.repeat(180),
      source_message_id: 'msg-budget', valid_from: '2026-10-01T00:00:00.000Z',
    });
    await reviewItem(db, 'agent:dots', item.id, 'approve', 'Recorded.', await itemContentDigest(item));
    const wr = new Workroom(db, 'agent:grok');
    for (const folds of [false, true]) {
      const wide = await wr.contextPack({ room: ROOM, task: 'budget', budget_chars: 6000, at: AT, folds });
      const budget = Math.max(500, JSON.stringify(wide.data.sections).length);
      const tight = await wr.contextPack({ room: ROOM, task: 'budget', budget_chars: budget, at: AT, folds });
      assert.ok(JSON.stringify(tight.data).length <= budget, `final ${folds ? 'folded' : 'plain'} data must fit ${budget}`);
      assert.equal(tight.data.used_chars, JSON.stringify(tight.data).length);
    }
  } finally { await close(); }
});
