import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { migrate } from '../scripts/local-harness.ts';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import { Fault } from '../src/server/contracts.ts';
import type { Database } from '../src/server/db.ts';
import { Workroom } from '../src/server/domain.ts';
import type { ContextSections, PackEntry } from '../src/server/context-pack.ts';
import type { FoldContextSections } from '../src/server/fold-pack.ts';
import {
  PINNED_LIMIT, assertStandingFits, buildOwnerMemory,
  type HookKind, type OwnerMemory,
} from '../src/server/memory-hook.ts';
import { pinTable } from '../src/server/pin-table.ts';
import type { OwnerDecision } from '../src/server/owner-decisions.ts';
import { proposeItem, type MemoryItem } from '../src/server/memory-items.ts';
import { itemContentDigest, reviewItem } from '../src/server/memory-review.ts';

// U7/G4: standing owner notices (MEM-HOOK pinned core) and the pin comparison table.
// All decision data here is fixture data through the pure buildOwnerMemory seam:
// this repo's owner-decisions module is the D5-cm boundary stub, so no real ledger
// is read and nothing is fabricated into a pack or a brief.

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
    assert.deepEqual(Object.keys(res.data), ['sections', 'used_chars', 'truncated', 'lineage', 'pin_table']);
    assert.deepEqual(res.data.pin_table, [
      { section: 'decisions', entry_id: item.id, source_message_id: 'msg-1', source_version: 1, source_current_version: 1, basis: 'pinned', status: 'current' },
    ]);
    const folded = await wr.contextPack({ room: ROOM, task: 'record', budget_chars: 6000, at: AT, folds: true });
    assert.deepEqual(folded.data.pin_table, res.data.pin_table);
  } finally { await close(); }
});
